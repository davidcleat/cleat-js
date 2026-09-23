import assert from "node:assert/strict";
import test from "node:test";
import { CleatClient } from "../src/client.js";
import { CleatTimeoutError } from "../src/errors.js";
import { CALL_TRANSCRIPT, LINE, MESSAGE, MESSAGE_WITHOUT_CODE, TEST_API_KEY, fakeClock, stubFetch } from "./helpers.js";

function client(responses: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(responses);
  const clock = fakeClock();
  return {
    stub,
    clock,
    cleat: new CleatClient({ apiKey: TEST_API_KEY, fetch: stub.fetch, sleep: clock.sleep, now: clock.now }),
  };
}

test("waitForCode resolves with just the code, so it can be piped", async () => {
  const { cleat } = client([
    { status: 200, body: { data: [] } },
    { status: 200, body: { data: [MESSAGE] } },
  ]);

  const code = await cleat.waitForCode(LINE.id, { since: "2026-09-11T10:00:00.000Z" });

  assert.equal(code, "704118");
});

test("waitForMessage hands back the whole message, transcript and all", async () => {
  const { cleat } = client([{ status: 200, body: { data: [CALL_TRANSCRIPT] } }]);

  const message = await cleat.waitForMessage(LINE.id, { since: "2026-09-11T10:00:00.000Z" });

  assert.equal(message.id, CALL_TRANSCRIPT.id);
  assert.equal(message.code, "519203");
  assert.match(message.body, /5 1 9 2 0 3/);
});

test("the poll walks forward from the newest receivedAt it has seen", async () => {
  const { cleat, stub } = client([
    { status: 200, body: { data: [MESSAGE_WITHOUT_CODE] } },
    { status: 200, body: { data: [MESSAGE] } },
  ]);

  await cleat.waitForCode(LINE.id, { since: "2026-09-11T09:00:00.000Z" });

  assert.equal(stub.urls.length, 2);
  // `after` returns oldest first, so the cursor is the LAST item of the previous page.
  assert.equal(new URL(stub.urls[0]!).searchParams.get("after"), "2026-09-11T09:00:00.000Z");
  assert.equal(new URL(stub.urls[1]!).searchParams.get("after"), MESSAGE_WITHOUT_CODE.receivedAt);
});

test("a message with no code is skipped rather than returned", async () => {
  const { cleat } = client([{ status: 200, body: { data: [MESSAGE_WITHOUT_CODE, MESSAGE] } }]);

  const code = await cleat.waitForCode(LINE.id, { since: "2026-09-11T09:00:00.000Z" });

  assert.equal(code, "704118");
});

test("the from filter ignores case and a leading plus", async () => {
  const { cleat } = client([{ status: 200, body: { data: [MESSAGE, CALL_TRANSCRIPT] } }]);

  const code = await cleat.waitForCode(LINE.id, {
    since: "2026-09-11T09:00:00.000Z",
    from: "+18005550199",
  });

  assert.equal(code, "519203");
});

test("the service filter matches the id or the name", async () => {
  const byId = client([{ status: 200, body: { data: [CALL_TRANSCRIPT, MESSAGE] } }]);
  assert.equal(await byId.cleat.waitForCode(LINE.id, { since: "2026-09-11T09:00:00.000Z", service: "facebook" }), "704118");

  const byName = client([{ status: 200, body: { data: [CALL_TRANSCRIPT, MESSAGE] } }]);
  assert.equal(await byName.cleat.waitForCode(LINE.id, { since: "2026-09-11T09:00:00.000Z", service: "Facebook" }), "704118");
});

test("waitForCode times out with a CleatTimeoutError and does not poll faster than asked", async () => {
  const { cleat, clock } = client([{ status: 200, body: { data: [] } }]);

  await assert.rejects(
    () => cleat.waitForCode(LINE.id, { since: "2026-09-11T09:00:00.000Z", timeoutMs: 9000, pollMs: 3000 }),
    (err: unknown) => {
      assert.ok(err instanceof CleatTimeoutError);
      assert.match(err.message, /within 9000ms/);
      return true;
    },
  );
  // 9s at 3s a poll: three sleeps, none longer than asked.
  assert.deepEqual(clock.waits, [3000, 3000, 3000]);
});

test("pollMs is floored at 1000, so a caller cannot hammer the rate limit", async () => {
  const { cleat, clock } = client([{ status: 200, body: { data: [] } }]);

  await assert.rejects(
    () => cleat.waitForCode(LINE.id, { since: "2026-09-11T09:00:00.000Z", timeoutMs: 2500, pollMs: 1 }),
    CleatTimeoutError,
  );

  // A 1ms pollMs is raised to the 1000ms floor. The last sleep is short only because
  // the client will not sleep past the deadline it was given.
  assert.deepEqual(clock.waits, [1000, 1000, 500]);
});

test("an aborted signal stops the wait", async () => {
  const { cleat } = client([{ status: 200, body: { data: [] } }]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => cleat.waitForCode(LINE.id, { signal: controller.signal }));
});
