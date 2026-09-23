import assert from "node:assert/strict";
import test from "node:test";
import { CleatClient } from "../src/client.js";
import {
  AuthenticationError,
  BadRequestError,
  CleatError,
  KeyExpiredError,
  LineOnHoldError,
  NotFoundError,
  RateLimitError,
  VerificationRequiredError,
} from "../src/errors.js";
import { CALL_TRANSCRIPT, LINE, MESSAGE, MESSAGE_WITHOUT_CODE, TEST_API_KEY, fakeClock, stubFetch } from "./helpers.js";

function client(responses: Parameters<typeof stubFetch>[0], options: { maxRetries?: number } = {}) {
  const stub = stubFetch(responses);
  const clock = fakeClock();
  return {
    stub,
    clock,
    cleat: new CleatClient({
      apiKey: TEST_API_KEY,
      fetch: stub.fetch,
      sleep: clock.sleep,
      now: clock.now,
      maxRetries: options.maxRetries ?? 2,
    }),
  };
}

test("listLines returns the workspace's lines and sends the bearer key", async () => {
  const { cleat, stub } = client([{ status: 200, body: { data: [LINE] } }]);

  const lines = await cleat.listLines();

  assert.deepEqual(lines, [LINE]);
  assert.equal(stub.urls[0], "https://cleat.so/api/v1/lines");
  assert.equal(stub.headers[0]?.authorization, `Bearer ${TEST_API_KEY}`);
});

test("listLines tolerates a status this version has never heard of", async () => {
  const future = { ...LINE, status: "hibernating" };
  const { cleat } = client([{ status: 200, body: { data: [future] } }]);

  const [line] = await cleat.listLines();

  assert.equal(line?.status, "hibernating");
});

test("listMessages parses a full message, a null code and a call transcript", async () => {
  const { cleat } = client([{ status: 200, body: { data: [MESSAGE_WITHOUT_CODE, MESSAGE, CALL_TRANSCRIPT] } }]);

  const messages = await cleat.listMessages(LINE.id);

  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.code, null);
  assert.equal(messages[0]?.service, null);
  assert.equal(messages[1]?.service?.id, "facebook");
  assert.equal(messages[1]?.code, "704118");
  // A call arrives as an ordinary message: transcript in body, caller in from.
  assert.equal(messages[2]?.code, "519203");
  assert.match(messages[2]?.body ?? "", /Your verification code is/);
  assert.equal(messages[2]?.contact?.name, "Payments provider");
});

test("listMessages serialises after, before and limit into the query string", async () => {
  const { cleat, stub } = client([{ status: 200, body: { data: [] } }]);

  await cleat.listMessages(LINE.id, {
    after: new Date("2026-09-11T10:00:00.000Z"),
    before: "2026-09-12T00:00:00Z",
    limit: 200,
  });

  const url = new URL(stub.urls[0]!);
  assert.equal(url.pathname, `/api/v1/lines/${LINE.id}/messages`);
  assert.equal(url.searchParams.get("after"), "2026-09-11T10:00:00.000Z");
  assert.equal(url.searchParams.get("before"), "2026-09-12T00:00:00Z");
  assert.equal(url.searchParams.get("limit"), "200");
});

test("listMessages refuses an out-of-range limit rather than letting it be clamped", async () => {
  const { cleat, stub } = client([{ status: 200, body: { data: [] } }]);

  await assert.rejects(() => cleat.listMessages(LINE.id, { limit: 201 }), CleatError);
  await assert.rejects(() => cleat.listMessages(LINE.id, { limit: 0 }), CleatError);
  assert.equal(stub.urls.length, 0);
});

test("a missing key is refused before any request is made", () => {
  assert.throws(() => new CleatClient({ apiKey: "", fetch: stubFetch([]).fetch }), CleatError);
});

test("400 becomes BadRequestError and keeps the API's own sentence", async () => {
  const { cleat } = client([{ status: 400, body: { error: "after must be an ISO 8601 timestamp." } }]);

  await assert.rejects(() => cleat.listMessages(LINE.id, { after: "not a date" }), (err: unknown) => {
    assert.ok(err instanceof BadRequestError);
    assert.equal(err.status, 400);
    assert.equal(err.message, "after must be an ISO 8601 timestamp.");
    return true;
  });
});

test("a plain 401 is AuthenticationError, and an expired key is KeyExpiredError", async () => {
  const revoked = client([{ status: 401, body: { error: "This API key is not valid." } }]);
  await assert.rejects(() => revoked.cleat.listLines(), (err: unknown) => {
    assert.ok(err instanceof AuthenticationError);
    assert.ok(!(err instanceof KeyExpiredError));
    return true;
  });

  const expired = client([{ status: 401, body: { error: "This API key has expired.", code: "key_expired" } }]);
  await assert.rejects(() => expired.cleat.listLines(), (err: unknown) => {
    assert.ok(err instanceof KeyExpiredError);
    // A KeyExpiredError is still an AuthenticationError, so a broad catch keeps working.
    assert.ok(err instanceof AuthenticationError);
    assert.equal(err.code, "key_expired");
    return true;
  });
});

test("402 is LineOnHoldError and 403 verify_first is VerificationRequiredError", async () => {
  const hold = client([{ status: 402, body: { error: "This line is on hold. Resubscribe to read its texts." } }]);
  await assert.rejects(() => hold.cleat.listMessages(LINE.id), LineOnHoldError);

  const verify = client([{ status: 403, body: { error: "Verify your identity to read texts.", code: "verify_first" } }]);
  await assert.rejects(() => verify.cleat.listMessages(LINE.id), (err: unknown) => {
    assert.ok(err instanceof VerificationRequiredError);
    assert.equal(err.code, "verify_first");
    return true;
  });
});

test("404 covers both a missing line and a line outside the key's scope", async () => {
  const { cleat } = client([{ status: 404, body: { error: "Not found." } }]);

  await assert.rejects(() => cleat.listMessages("7c3e1a90-0000-4000-8000-000000000000"), NotFoundError);
});

test("429 is retried with its own backoff, then succeeds", async () => {
  const { cleat, stub, clock } = client([
    { status: 429, body: { error: "Rate limit exceeded: 120 requests per minute." } },
    { status: 200, body: { data: [LINE] } },
  ]);

  const lines = await cleat.listLines();

  assert.deepEqual(lines, [LINE]);
  assert.equal(stub.urls.length, 2);
  // No Retry-After from Cleat, so the first backoff is the client's own ~1s.
  assert.equal(clock.waits.length, 1);
  assert.ok(clock.waits[0]! >= 1000 && clock.waits[0]! < 1300, `unexpected backoff ${clock.waits[0]}`);
});

test("429 honours Retry-After when a proxy does send one", async () => {
  const { cleat, clock } = client([
    { status: 429, body: { error: "Slow down." }, headers: { "retry-after": "7" } },
    { status: 200, body: { data: [] } },
  ]);

  await cleat.listLines();

  assert.deepEqual(clock.waits, [7000]);
});

test("429 throws RateLimitError once the retries are spent", async () => {
  const { cleat, stub } = client(
    [{ status: 429, body: { error: "Rate limit exceeded: 120 requests per minute." } }],
    { maxRetries: 2 },
  );

  await assert.rejects(() => cleat.listLines(), (err: unknown) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.retryAfterSeconds, undefined);
    return true;
  });
  // The first try plus two retries.
  assert.equal(stub.urls.length, 3);
});

test("maxRetries 0 makes a 429 throw straight away", async () => {
  const { cleat, stub } = client([{ status: 429, body: { error: "Rate limit exceeded." } }], { maxRetries: 0 });

  await assert.rejects(() => cleat.listLines(), RateLimitError);
  assert.equal(stub.urls.length, 1);
});

test("a 5xx that is not JSON still produces a readable error", async () => {
  const { cleat } = client([{ status: 500, body: "<html>bad gateway</html>" }], { maxRetries: 0 });

  await assert.rejects(() => cleat.listLines(), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /bad gateway/);
    return true;
  });
});
