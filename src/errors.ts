import type { ApiErrorBody } from "./types.js";

/** Every error this library throws on purpose. */
export class CleatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A non-2xx answer from the API. */
export class CleatApiError extends CleatError {
  /** The HTTP status. */
  readonly status: number;
  /** The machine-readable `code` from the body, when the API sent one. */
  readonly code: string | undefined;
  /** The parsed error body, or the raw text when it was not JSON. */
  readonly body: ApiErrorBody | string | undefined;

  constructor(status: number, message: string, code?: string, body?: ApiErrorBody | string) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 400: `after` or `before` was not an ISO 8601 timestamp. */
export class BadRequestError extends CleatApiError {}

/** 401: the key is missing, malformed, revoked, or its workspace owner is disabled. */
export class AuthenticationError extends CleatApiError {}

/** 401 with `code` `key_expired`: the key was created with an expiry that has passed. */
export class KeyExpiredError extends AuthenticationError {}

/** 402: the line is on hold. Its texts are held and cannot be read until it is resubscribed. */
export class LineOnHoldError extends CleatApiError {}

/**
 * 403 with `code` `verify_first`: the workspace owner has not verified their identity yet.
 * The line runs and keeps every text it receives, but none can be read until they do.
 */
export class VerificationRequiredError extends CleatApiError {}

/**
 * 404: no line with that id in this key's workspace.
 *
 * A line outside the key's scope answers 404 too, exactly like a line in another
 * workspace, so this error cannot tell you which of the two happened.
 */
export class NotFoundError extends CleatApiError {}

/** 429: more than 120 requests in a minute on this key. */
export class RateLimitError extends CleatApiError {
  /**
   * Seconds to wait, from a `Retry-After` header. Cleat does not currently send one,
   * so expect this to be `undefined` and fall back to the client's own backoff.
   */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    message: string,
    code?: string,
    body?: ApiErrorBody | string,
    retryAfterSeconds?: number,
  ) {
    super(status, message, code, body);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A request, or a whole wait, ran out of time. */
export class CleatTimeoutError extends CleatError {}

/** Why a webhook signature was rejected. */
export type SignatureFailure =
  /** The `cleat-signature` header was absent or could not be parsed. */
  | "malformed_header"
  /** `t` was outside the tolerance: too old, or too far in the future. */
  | "stale_timestamp"
  /** The digest did not match. Wrong secret, or the body was changed in flight. */
  | "signature_mismatch"
  /** The signature checked out but the body was not the JSON envelope Cleat sends. */
  | "malformed_body";

/** A webhook delivery could not be trusted. Answer 401 and do not process it. */
export class CleatSignatureError extends CleatError {
  readonly reason: SignatureFailure;

  constructor(reason: SignatureFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Turn a non-2xx response into the narrowest error class that fits.
 * Unmapped statuses (a 500, say) stay {@link CleatApiError}.
 */
export function errorForStatus(
  status: number,
  body: ApiErrorBody | string | undefined,
  retryAfterSeconds?: number,
): CleatApiError {
  const parsed = typeof body === "object" && body !== null ? body : undefined;
  const message = parsed?.error ?? (typeof body === "string" && body.trim() ? body.trim() : `Cleat API answered ${status}.`);
  const code = parsed?.code;

  switch (status) {
    case 400:
      return new BadRequestError(status, message, code, body);
    case 401:
      return code === "key_expired"
        ? new KeyExpiredError(status, message, code, body)
        : new AuthenticationError(status, message, code, body);
    case 402:
      return new LineOnHoldError(status, message, code, body);
    case 403:
      return new VerificationRequiredError(status, message, code, body);
    case 404:
      return new NotFoundError(status, message, code, body);
    case 429:
      return new RateLimitError(status, message, code, body, retryAfterSeconds);
    default:
      return new CleatApiError(status, message, code, body);
  }
}
