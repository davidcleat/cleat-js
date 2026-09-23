import { CleatError, CleatTimeoutError, errorForStatus } from "./errors.js";
import type {
  ApiErrorBody,
  FetchLike,
  Line,
  ListMessagesOptions,
  Message,
  WaitOptions,
} from "./types.js";

/** Options for {@link CleatClient}. */
export interface CleatClientOptions {
  /** A key from workspace settings, starting `clt_`. Defaults to `process.env.CLEAT_API_KEY`. */
  apiKey?: string;
  /** Defaults to `https://cleat.so`. */
  baseUrl?: string;
  /** How long one request may take, in ms. Default 30000. */
  timeoutMs?: number;
  /**
   * How many times to retry a 429 or a transient 5xx before giving up. Default 2.
   * Set to 0 to have every rate-limited request throw straight away.
   */
  maxRetries?: number;
  /** Supply your own `fetch`, e.g. a stub in tests or a proxying wrapper. */
  fetch?: FetchLike;
  /** Sleep function, so tests do not have to wait. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock, in ms since the epoch. Defaults to `Date.now`. Pair it with `sleep` in tests. */
  now?: () => number;
}

const DEFAULT_BASE_URL = "https://cleat.so";
const USER_AGENT = "cleatapi/0.1.0";
/** The API accepts 1 to 200 and defaults to 50. */
const MAX_LIMIT = 200;
/** Polling faster than this is rude and eats the 120/minute budget for nothing. */
const MIN_POLL_MS = 1000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isoOf(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new CleatError("Invalid Date passed as a timestamp.");
    return value.toISOString();
  }
  if (typeof value === "string") {
    // Let the API be the judge of the format; it answers 400 with a clear message.
    return value;
  }
  throw new CleatError("Expected a Date or an ISO 8601 string.");
}

/** Normalise a sender for comparison: case-insensitive, and a leading `+` means nothing. */
function sameSender(a: string, b: string): boolean {
  const strip = (v: string) => v.trim().replace(/^\+/, "").toLowerCase();
  return strip(a) === strip(b);
}

/**
 * A client for the Cleat read API.
 *
 * Every method throws a subclass of `CleatApiError` on a non-2xx answer, so you can
 * catch `KeyExpiredError` or `VerificationRequiredError` specifically.
 *
 * @example
 * ```ts
 * const cleat = new CleatClient(); // reads CLEAT_API_KEY
 * const [line] = await cleat.listLines();
 * const code = await cleat.waitForCode(line.id, { timeoutMs: 120_000 });
 * ```
 */
export class CleatClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: CleatClientOptions = {}) {
    const apiKey =
      options.apiKey ??
      (typeof process !== "undefined" ? process.env?.CLEAT_API_KEY : undefined);
    if (!apiKey) {
      throw new CleatError(
        "No API key. Pass { apiKey } or set CLEAT_API_KEY. Keys are created in Cleat workspace settings and start with clt_.",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    const supplied = options.fetch ?? (typeof globalThis.fetch === "function" ? (globalThis.fetch as unknown as FetchLike) : undefined);
    if (!supplied) {
      throw new CleatError("No fetch available. Use Node 18 or newer, or pass { fetch }.");
    }
    this.fetchImpl = supplied;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /**
   * The lines in this key's workspace, newest first.
   *
   * Released lines are still listed, so an id in your own records still resolves to
   * something. A key scoped to named lines only sees those.
   */
  async listLines(options: { signal?: AbortSignal } = {}): Promise<Line[]> {
    const body = await this.request<{ data: Line[] }>("/api/v1/lines", {}, options.signal);
    return body.data ?? [];
  }

  /**
   * The messages one line received.
   *
   * Mind the order, because it is what makes polling work: with `after` the API returns
   * the oldest first, so you can walk them and keep the last `receivedAt` as your cursor.
   * With `before`, or with neither, it returns the newest first.
   */
  async listMessages(lineId: string, options: ListMessagesOptions = {}): Promise<Message[]> {
    if (!lineId) throw new CleatError("listMessages needs a line id.");
    const query: Record<string, string> = {};
    if (options.after !== undefined) query.after = isoOf(options.after);
    if (options.before !== undefined) query.before = isoOf(options.before);
    if (options.limit !== undefined) {
      // The API clamps a limit outside its range rather than refusing it. Clamping
      // silently is worse for a caller than saying so, so this refuses instead.
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
        throw new CleatError(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
      }
      query.limit = String(options.limit);
    }
    const body = await this.request<{ data: Message[] }>(
      `/api/v1/lines/${encodeURIComponent(lineId)}/messages`,
      query,
      options.signal,
    );
    return body.data ?? [];
  }

  /**
   * Poll a line until a message arrives that carries a code, then resolve with the
   * message. Only messages received after `since` count, and `since` defaults to now,
   * so a code already in the inbox is not mistaken for a fresh one.
   *
   * @throws {CleatTimeoutError} when `timeoutMs` passes with nothing matching.
   */
  async waitForMessage(lineId: string, options: WaitOptions = {}): Promise<Message> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollMs = Math.max(options.pollMs ?? 3000, MIN_POLL_MS);
    const deadline = this.now() + timeoutMs;
    let cursor = isoOf(options.since ?? new Date());

    for (;;) {
      options.signal?.throwIfAborted?.();

      // `after` gives us oldest first, so the last one we see is the newest cursor.
      const messages = await this.listMessages(lineId, {
        after: cursor,
        limit: MAX_LIMIT,
        signal: options.signal,
      });

      for (const message of messages) {
        if (message.code === null) continue;
        if (options.from && !sameSender(message.from, options.from)) continue;
        if (options.service && !matchesService(message, options.service)) continue;
        return message;
      }
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last) cursor = last.receivedAt;
      }

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new CleatTimeoutError(
          `No matching code on line ${lineId} within ${timeoutMs}ms. Nothing was charged and the line is still listening.`,
        );
      }
      await this.sleep(Math.min(pollMs, remaining));
    }
  }

  /**
   * The same wait as {@link waitForMessage}, resolving with just the extracted code.
   *
   * `code` is best effort. When the exact characters matter, use `waitForMessage` and
   * read `body` yourself.
   */
  async waitForCode(lineId: string, options: WaitOptions = {}): Promise<string> {
    const message = await this.waitForMessage(lineId, options);
    // waitForMessage only ever returns a message whose code is non-null.
    return message.code as string;
  }

  /** One request, with retries for a 429 or a transient 5xx. */
  private async request<T>(
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const search = new URLSearchParams(query).toString();
    const url = `${this.baseUrl}${path}${search ? `?${search}` : ""}`;

    let attempt = 0;
    for (;;) {
      signal?.throwIfAborted?.();
      const { status, ok, retryAfterSeconds, text } = await this.send(url, signal);

      if (ok) {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new CleatError(`Cleat answered ${status} with a body that is not JSON.`);
        }
      }

      const body = parseErrorBody(text);
      const retriable = status === 429 || status === 502 || status === 503 || status === 504;
      if (!retriable || attempt >= this.maxRetries) {
        throw errorForStatus(status, body, retryAfterSeconds);
      }

      // Cleat's 429 carries no Retry-After and no rate-limit headers, so the backoff is
      // ours: 1s, 2s, 4s with jitter. Honour Retry-After anyway, in case that changes.
      const backoff = retryAfterSeconds !== undefined
        ? retryAfterSeconds * 1000
        : 2 ** attempt * 1000 + Math.floor(Math.random() * 250);
      attempt += 1;
      await this.sleep(backoff);
    }
  }

  /** The bare HTTP call, with a per-request timeout. */
  private async send(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; ok: boolean; retryAfterSeconds: number | undefined; text: string }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new CleatTimeoutError(`Request to ${url} took longer than ${this.timeoutMs}ms.`)), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        signal: controller.signal,
      });
      const header = response.headers?.get?.("retry-after") ?? null;
      const retryAfterSeconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : undefined;
      return {
        status: response.status,
        ok: response.ok ?? (response.status >= 200 && response.status < 300),
        retryAfterSeconds,
        text: await response.text(),
      };
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason instanceof CleatTimeoutError) {
        throw controller.signal.reason;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function matchesService(message: Message, wanted: string): boolean {
  const want = wanted.trim().toLowerCase();
  const service = message.service;
  if (!service) return false;
  return service.id.toLowerCase() === want || service.name.toLowerCase() === want;
}

function parseErrorBody(text: string): ApiErrorBody | string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as ApiErrorBody).error === "string") {
      return parsed as ApiErrorBody;
    }
  } catch {
    // Fall through: a proxy or an edge error page is not always JSON.
  }
  return text;
}
