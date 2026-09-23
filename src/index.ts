/**
 * A client for the Cleat API: read the texts and transcribed calls that arrive on your
 * own US mobile lines.
 *
 * @see https://cleat.so/for/developers
 */
export { CleatClient } from "./client.js";
export type { CleatClientOptions } from "./client.js";

export {
  parseSignatureHeader,
  signWebhook,
  verifyWebhook,
} from "./webhook.js";
export type { ParsedSignature, VerifyWebhookOptions } from "./webhook.js";

export {
  AuthenticationError,
  BadRequestError,
  CleatApiError,
  CleatError,
  CleatSignatureError,
  CleatTimeoutError,
  KeyExpiredError,
  LineOnHoldError,
  NotFoundError,
  RateLimitError,
  VerificationRequiredError,
} from "./errors.js";
export type { SignatureFailure } from "./errors.js";

export type {
  ApiErrorBody,
  Contact,
  FetchLike,
  Line,
  LineStatus,
  ListMessagesOptions,
  Message,
  MessageLine,
  Service,
  WaitOptions,
  WebhookEvent,
} from "./types.js";
