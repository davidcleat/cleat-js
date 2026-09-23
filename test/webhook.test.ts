import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { CleatSignatureError } from "../src/errors.js";
import { parseSignatureHeader, signWebhook, verifyWebhook } from "../src/webhook.js";
import { MESSAGE, TEST_WEBHOOK_SECRET } from "./helpers.js";

/** The exact body Cleat POSTs. Keep it as a string: the signature is over these bytes. */
const RAW_BODY = JSON.stringify({ type: "message.received", data: MESSAGE });
const NOW = 1789120961;

test("a correctly signed delivery verifies and yields the event", () => {
  const header = signWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, NOW);

  const event = verifyWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, header, { now: NOW });

  assert.equal(event.type, "message.received");
  assert.equal(event.data.code, "704118");
  assert.equal(event.data.line.phone, "13055550100");
});

test("the signed string is the timestamp, a dot, then the raw body", () => {
  // Pinned against the scheme itself, not against our own helper.
  const expected = createHmac("sha256", TEST_WEBHOOK_SECRET).update(`${NOW}.${RAW_BODY}`).digest("hex");

  assert.equal(signWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, NOW), `t=${NOW},v1=${expected}`);
});

test("the body may be passed as bytes, which is what a raw-body parser gives you", () => {
  const bytes = Buffer.from(RAW_BODY, "utf8");
  const header = signWebhook(TEST_WEBHOOK_SECRET, bytes, NOW);

  const event = verifyWebhook(TEST_WEBHOOK_SECRET, bytes, header, { now: NOW });

  assert.equal(event.type, "message.received");
});

test("a test delivery from workspace settings verifies too", () => {
  const body = JSON.stringify({ type: "test", data: MESSAGE });
  const header = signWebhook(TEST_WEBHOOK_SECRET, body, NOW);

  assert.equal(verifyWebhook(TEST_WEBHOOK_SECRET, body, header, { now: NOW }).type, "test");
});

test("an event type this version has never seen is still returned, not thrown", () => {
  const body = JSON.stringify({ type: "something.new", data: MESSAGE });
  const header = signWebhook(TEST_WEBHOOK_SECRET, body, NOW);

  assert.equal(verifyWebhook(TEST_WEBHOOK_SECRET, body, header, { now: NOW }).type, "something.new");
});

test("a tampered body is rejected", () => {
  const header = signWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, NOW);
  const tampered = RAW_BODY.replace("704118", "000000");
  assert.notEqual(tampered, RAW_BODY);

  assert.throws(
    () => verifyWebhook(TEST_WEBHOOK_SECRET, tampered, header, { now: NOW }),
    (err: unknown) => {
      assert.ok(err instanceof CleatSignatureError);
      assert.equal(err.reason, "signature_mismatch");
      return true;
    },
  );
});

test("re-serialising the JSON breaks the signature, which is why raw bytes matter", () => {
  const header = signWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, NOW);
  // What you get if you verify against JSON.stringify(req.body) instead of the bytes.
  const reserialised = JSON.stringify(JSON.parse(RAW_BODY), null, 2);

  assert.throws(() => verifyWebhook(TEST_WEBHOOK_SECRET, reserialised, header, { now: NOW }), CleatSignatureError);
});

test("a signature made with the wrong secret is rejected", () => {
  const header = signWebhook("whsec_some_other_secret", RAW_BODY, NOW);

  assert.throws(
    () => verifyWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, header, { now: NOW }),
    (err: unknown) => {
      assert.ok(err instanceof CleatSignatureError);
      assert.equal(err.reason, "signature_mismatch");
      return true;
    },
  );
});

test("a stale timestamp is rejected, and so is one from the future", () => {
  const old = signWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, NOW - 301);
  assert.throws(() => verifyWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, old, { now: NOW }), (err: unknown) => {
    assert.ok(err instanceof CleatSignatureError);
    assert.equal(err.reason, "stale_timestamp");
    return true;
  });

  const ahead = signWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, NOW + 301);
  assert.throws(() => verifyWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, ahead, { now: NOW }), CleatSignatureError);

  // Just inside the window is fine.
  const fresh = signWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, NOW - 299);
  assert.equal(verifyWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, fresh, { now: NOW }).type, "message.received");
});

test("the tolerance is configurable, for replaying a stored delivery on purpose", () => {
  const ancient = signWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, NOW - 90_000);

  assert.equal(
    verifyWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, ancient, { now: NOW, toleranceSeconds: Infinity }).type,
    "message.received",
  );
});

test("a malformed or missing header is rejected as malformed, not as a mismatch", () => {
  for (const header of [null, undefined, "", "nonsense", "t=123", "v1=abc", "t=notanumber,v1=abc", `t=${NOW},v1=zzzz`]) {
    assert.throws(
      () => verifyWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, header as string | null, { now: NOW }),
      (err: unknown) => {
        assert.ok(err instanceof CleatSignatureError, `expected a signature error for ${String(header)}`);
        assert.equal(err.reason, "malformed_header", `wrong reason for ${String(header)}`);
        return true;
      },
    );
  }
});

test("a signature over a body that is not the Cleat envelope is reported as such", () => {
  const body = "[1,2,3]";
  const header = signWebhook(TEST_WEBHOOK_SECRET, body, NOW);

  assert.throws(() => verifyWebhook(TEST_WEBHOOK_SECRET, body, header, { now: NOW }), (err: unknown) => {
    assert.ok(err instanceof CleatSignatureError);
    assert.equal(err.reason, "malformed_body");
    return true;
  });
});

test("an empty secret is refused rather than silently verifying nothing", () => {
  const header = signWebhook(TEST_WEBHOOK_SECRET, RAW_BODY, NOW);

  assert.throws(() => verifyWebhook("", RAW_BODY, header, { now: NOW }), CleatSignatureError);
});

test("parseSignatureHeader copes with whitespace and mixed-case hex", () => {
  const parsed = parseSignatureHeader(" t=1789120961 , v1=ABCDEF0123 ");

  assert.equal(parsed.timestamp, 1789120961);
  assert.equal(parsed.v1, "abcdef0123");
});
