# cleatapi

A TypeScript client for the [Cleat](https://cleat.so) API: read the texts and transcribed calls that arrive on your own US mobile lines, and verify Cleat's signed webhooks.

Zero runtime dependencies. ESM and CommonJS. Node 18 or newer.

## What Cleat is

Cleat rents ID-verified US mobile numbers that receive SMS and 2FA codes, and transcripts of incoming calls. A line is $24.99 a month or $249.90 a year.

It is **receive-only**: a line cannot send a text, place a call, or reach 911. That is why this library has no write methods — there is nothing to write. A line belongs to one identity-verified owner, and teammates in the same workspace read the same inbox at no extra cost. Codes arrive in a web inbox, by email, on Telegram, by signed webhook, through this REST API, and via an MCP server.

Cleat is for your own accounts, or your company's: the cloud console, the registrar, the payment processor, and the sign-up and login flows you test in staging.

## Install

```sh
npm install cleatapi
```

The package is [`cleatapi`](https://www.npmjs.com/package/cleatapi): the bare name `cleat` on npm belongs to an unrelated command line tool published in 2015. The repository keeps the name `cleat-js`.

## Wait for a code

```ts
import { CleatClient } from "cleatapi";

// Reads CLEAT_API_KEY from the environment.
const cleat = new CleatClient();

const lines = await cleat.listLines();
const line = lines.find((l) => l.status === "active");
if (!line) throw new Error("No active line in this workspace.");

console.log(`Waiting for a code on +${line.phone}...`);

// Polls every 3 seconds, gives up after two minutes.
const code = await cleat.waitForCode(line.id, { timeoutMs: 120_000 });

console.log(code); // "704118"
```

Run it:

```sh
export CLEAT_API_KEY=clt_your_key_here
node wait.js      # or run the .ts with tsx, or compile it with tsc first
```

`waitForCode` only looks at messages that arrive **after** the call starts, so a code already sitting in the inbox is not mistaken for a fresh one. Pass `since` to change that.

### Read what is already there

```ts
const messages = await cleat.listMessages(line.id, { limit: 20 });

for (const message of messages) {
  // `label` is the contact's name, else the service Cleat recognised, else null.
  console.log(message.receivedAt, message.label ?? message.from, message.code ?? message.body);
}
```

### Poll forwards with a cursor

`after` returns messages **oldest first**, so the last one you see is your next cursor. That is also how you catch up on anything a webhook could not deliver:

```ts
let cursor = new Date(Date.now() - 60 * 60 * 1000).toISOString();

for (;;) {
  const batch = await cleat.listMessages(line.id, { after: cursor, limit: 200 });
  for (const message of batch) handle(message);
  if (batch.length > 0) cursor = batch[batch.length - 1].receivedAt;
  await new Promise((r) => setTimeout(r, 5000));
}
```

### Verify a webhook

Cleat POSTs `{"type":"message.received","data":{...}}` to your endpoint and signs it. Verify over the **raw bytes** — parsing and re-serialising the JSON changes them, and the signature will not match.

```ts
import express from "express";
import { verifyWebhook, CleatSignatureError } from "cleatapi";

const app = express();

app.post("/cleat-webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyWebhook(process.env.CLEAT_WEBHOOK_SECRET, req.body, req.get("cleat-signature"));
  } catch (err) {
    if (err instanceof CleatSignatureError) return res.sendStatus(401);
    throw err;
  }

  if (event.type === "message.received") {
    // A failed delivery is retried, so the same id can arrive twice. Skip ones you have.
    console.log(event.data.id, event.data.from, event.data.code ?? event.data.body);
  }

  res.sendStatus(200);
});
```

`verifyWebhook` rejects a bad digest, a stale timestamp (300 seconds either way by default) and a malformed header, each with its own `reason`, so you can log which it was. It uses `node:crypto`. On a runtime that has WebCrypto only, such as a Cloudflare Worker without Node compatibility, the same check is a dozen lines of `crypto.subtle` — the `cleat-webhooks` examples repo has that version.

## How to get an API key

1. Create a Cleat account at [cleat.so](https://cleat.so) and subscribe to a line.
2. Verify your identity once, as the line's owner. Until you do, the line runs and keeps every text it receives, but reading messages answers `403` with the code `verify_first`. `listLines()` works before verifying; `listMessages()` and `waitForCode()` do not.
3. In **workspace settings**, create an API key. It starts with `clt_` and is shown once, so copy it then.

A key belongs to one workspace. You can narrow it further when you create it: to named lines, and to a date it stops working — which is what makes a key safe to hand to an agent or a contractor. A line outside a key's scope answers `404`, exactly like a line in another workspace, so this library cannot tell you which of the two happened.

Webhook endpoints are created in the same settings page. An endpoint's signing secret starts with `whsec_` and is also shown once.

## API surface

| | |
|---|---|
| `new CleatClient(options?)` | `apiKey` (defaults to `CLEAT_API_KEY`), `baseUrl`, `timeoutMs`, `maxRetries`, `fetch`, `sleep`, `now` |
| `listLines()` | `Promise<Line[]>`, newest first |
| `listMessages(lineId, { after, before, limit, signal })` | `Promise<Message[]>` |
| `waitForMessage(lineId, { since, from, service, timeoutMs, pollMs, signal })` | `Promise<Message>` — the first message with a code |
| `waitForCode(lineId, sameOptions)` | `Promise<string>` — just the code |
| `verifyWebhook(secret, rawBody, header, { toleranceSeconds, now })` | `WebhookEvent`, throws `CleatSignatureError` |
| `signWebhook(secret, rawBody, timestamp?)` | a `cleat-signature` header, for your own tests |
| `parseSignatureHeader(header)` | `{ timestamp, v1 }` |

Types: `Line`, `Message`, `MessageLine`, `Service`, `Contact`, `WebhookEvent`, `LineStatus`, `ListMessagesOptions`, `WaitOptions`, `FetchLike`, `ApiErrorBody`.

Errors, so you can catch the one you mean:

| Class | When |
|---|---|
| `BadRequestError` | `400` — `after`/`before` was not an ISO 8601 timestamp |
| `AuthenticationError` | `401` — key missing, malformed, revoked, or the owner's account is disabled |
| `KeyExpiredError` | `401` with code `key_expired`. A subclass of `AuthenticationError` |
| `LineOnHoldError` | `402` — the line is unpaid; its texts are held and cannot be read |
| `VerificationRequiredError` | `403` with code `verify_first` — the owner has not verified their identity |
| `NotFoundError` | `404` — no such line in this key's workspace, **or** outside the key's scope |
| `RateLimitError` | `429` — more than 120 requests a minute on this key |
| `CleatApiError` | any other non-2xx. The base class of all of the above |
| `CleatTimeoutError` | a request, or a whole `waitForCode`, ran out of time |
| `CleatSignatureError` | a webhook could not be trusted. Has a `reason` |
| `CleatError` | the base of everything above |

A `429` is retried automatically with an exponential backoff and jitter — twice by default, configurable with `maxRetries`. Cleat's `429` sends no `Retry-After` header, so the backoff is this client's own; if a proxy in front of it ever does send one, the client honours it.

## Limits worth knowing before you build

- **Receive-only.** No outbound texts, no outbound calls, no 911. There is no send method because there is no send endpoint.
- **US numbers only.**
- **The owner verifies their identity once.** Government ID, or ID reviewed by a person. Nothing can be read before that.
- **One line is one subscription** with one verified owner. Cleat is not built for pools of numbers, load testing, or bulk sign-ups.
- **A call is not live.** An automated call that reads a code out is transcribed and lands as an ordinary message afterwards: the transcript in `body`, the calling number in `from`, `code` filled in. Nothing in the payload marks it as a call. There is no ringing to answer and no audio to stream.
- **`code` is best effort.** It is extracted for display and can be `null`. When the exact characters matter, read `body`.
- **`service` is conservative.** Several services share one short code, so `service` is `null` whenever it is not clear.
- **120 requests a minute per key.** Webhook deliveries do not count against it.
- **Whether a given service accepts the number is up to that service.** Most services that refuse VoIP accept a real mobile line, but nobody can promise you a particular one will.
- **Only the workspace owner** can create API keys and webhook endpoints. A revoked key stops working immediately.

## Development

```sh
npm install
npm test        # compiles with tsc, then runs node --test. No network.
npm run build   # dist/esm and dist/cjs
npm run typecheck
```

The tests stub `fetch` and run on a virtual clock, so nothing sleeps and nothing leaves the machine.

## Links

- [cleat.so](https://cleat.so)
- [cleat.so/for/developers](https://cleat.so/for/developers) — the API reference, the webhook contract and the delivery details
- [cleat.so/openapi.json](https://cleat.so/openapi.json) — the OpenAPI description

## License

MIT. See [LICENSE](./LICENSE).
