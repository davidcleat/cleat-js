/**
 * The shapes the Cleat API returns.
 *
 * These mirror https://cleat.so/openapi.json. Fields the API marks as required are
 * required here even when they are nullable, because the API always sends the key.
 */

/** A line's billing/lifecycle state. */
export type LineStatus =
  /** Receiving. */
  | "active"
  /** Unpaid: texts are held and cannot be read. */
  | "grace"
  /** The number is gone. */
  | "released";

/** A number in the workspace. */
export interface Line {
  id: string;
  /** E.164 without the plus, e.g. `13055550100`. */
  phone: string;
  label: string | null;
  /**
   * One of {@link LineStatus}. Typed as a union with a `string` escape hatch so a
   * status added after this version was published does not break parsing.
   */
  status: LineStatus | (string & {});
  /** ISO 8601. */
  createdAt: string;
}

/** The line a message arrived on, as embedded in a message. */
export interface MessageLine {
  id: string;
  /** E.164 without the plus, e.g. `13055550100`. */
  phone: string;
  label: string | null;
}

/** A sender Cleat recognised, e.g. Facebook. */
export interface Service {
  /** A stable id, e.g. `facebook`. */
  id: string;
  /** The service's name, e.g. `Facebook`. */
  name: string;
  /** A hex colour for a badge, e.g. `#0866FF`. */
  color: string;
}

/** A name the workspace saved for a sender. */
export interface Contact {
  id: string;
  name: string;
  /** A hex colour for a badge. */
  color: string;
}

/**
 * One received text, or one transcribed incoming call.
 *
 * Nothing in the payload marks a delivery as a call rather than a text: a call arrives
 * with its transcript in `body`, the calling number in `from`, and `code` filled in.
 */
export interface Message {
  id: string;
  line: MessageLine;
  /** The sender as the network reported it: a number, or an alphanumeric sender id. */
  from: string;
  /** The full text. For a call, the transcript. */
  body: string;
  /**
   * The code as extracted, for display. Best effort, and `null` when nothing was found.
   * Read `body` when it matters.
   */
  code: string | null;
  /** ISO 8601. */
  receivedAt: string;
  /**
   * The service Cleat recognised from the text, or `null` when it isn't clear.
   * Recognition is conservative: several services share one short code.
   */
  service: Service | null;
  /** The workspace contact that matches this sender, or `null`. A contact beats `service`. */
  contact: Contact | null;
  /** What to show: the contact's name, else the service's name, else `null`. */
  label: string | null;
}

/** The body Cleat POSTs to a webhook endpoint. */
export interface WebhookEvent {
  /**
   * `message.received` for a real text or transcribed call, `test` for the test delivery
   * fired from workspace settings. Treat an unrecognised type as something to ignore.
   */
  type: "message.received" | "test" | (string & {});
  data: Message;
}

/** The error body the API returns with a non-2xx status. */
export interface ApiErrorBody {
  /** A sentence meant to be shown to a person. */
  error: string;
  code?: string;
}

/** Options for {@link CleatClient.listMessages}. */
export interface ListMessagesOptions {
  /**
   * Only messages received strictly after this moment. This switches the order to
   * oldest first, which is what makes it usable as a cursor.
   */
  after?: Date | string;
  /** Only messages received strictly before this moment. Order is newest first. */
  before?: Date | string;
  /** 1 to 200. The API defaults to 50. */
  limit?: number;
  signal?: AbortSignal;
}

/** Options for {@link CleatClient.waitForMessage} and {@link CleatClient.waitForCode}. */
export interface WaitOptions {
  /**
   * Only consider messages received after this moment. Defaults to the moment the wait
   * starts, so a code already sitting in the inbox is not mistaken for a fresh one.
   */
  since?: Date | string;
  /** Only match this sender, compared case-insensitively. A leading `+` is ignored. */
  from?: string;
  /** Only match this service, by its id or its name, compared case-insensitively. */
  service?: string;
  /** Give up after this long. Default 120000. */
  timeoutMs?: number;
  /** How long to wait between polls. Default 3000; the floor is 1000. */
  pollMs?: number;
  signal?: AbortSignal;
}

/** The subset of `fetch` this client uses, so a test or a proxy can supply its own. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;
