/** Test doubles. Nothing here touches the network. */
import type { FetchLike, Line, Message } from "../src/types.js";

/** One canned answer from the stub. */
export interface StubbedResponse {
  status: number;
  /** An object is serialised; a string is sent as-is, so a non-JSON body can be tested. */
  body: unknown;
  headers?: Record<string, string>;
}

export interface StubbedFetch {
  fetch: FetchLike;
  /** Every URL the client asked for, in order. */
  urls: string[];
  /** Every header set the client sent, in order. */
  headers: Record<string, string>[];
}

/**
 * A `fetch` that answers from a queue. The last entry is repeated once the queue runs
 * dry, so a polling test does not have to enumerate every attempt.
 */
export function stubFetch(responses: StubbedResponse[]): StubbedFetch {
  const queue = [...responses];
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];

  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    headers.push({ ...(init?.headers ?? {}) });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error("stubFetch ran out of responses");
    const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    const headerMap = new Map(Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      text: async () => text,
    };
  };

  return { fetch, urls, headers };
}

/**
 * A virtual clock. `sleep` returns at once but moves `now` forward, so a test for a
 * two-minute timeout finishes instantly and still measures the real arithmetic.
 */
export function fakeClock(startMs = Date.parse("2026-09-11T10:00:00.000Z")): {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  waits: number[];
} {
  let current = startMs;
  const waits: number[] = [];
  return {
    waits,
    now: () => current,
    sleep: async (ms: number) => {
      waits.push(ms);
      current += ms;
    },
  };
}

/** An obviously fake key. Never put a real one in a fixture. */
export const TEST_API_KEY = "clt_test_key_not_a_real_key";
/** An obviously fake webhook signing secret. */
export const TEST_WEBHOOK_SECRET = "whsec_test_secret";

export const LINE: Line = {
  id: "8f14e45f-ceea-4b6b-9d3c-2a1f0e7c5b10",
  phone: "13055550100",
  label: "Staging sign-ups",
  status: "active",
  createdAt: "2026-09-11T10:00:00.000Z",
};

/** A text from a recognised service, with a code extracted. */
export const MESSAGE: Message = {
  id: "c9a7e0d2-5b1f-4e8a-9f3c-6d2b1a0e4f77",
  line: { id: LINE.id, phone: LINE.phone, label: LINE.label },
  from: "32665",
  body: "704118 is your Facebook confirmation code",
  code: "704118",
  receivedAt: "2026-09-11T10:02:41.000Z",
  service: { id: "facebook", name: "Facebook", color: "#0866FF" },
  contact: null,
  label: "Facebook",
};

/** A text Cleat could not read a code out of, and did not recognise the sender of. */
export const MESSAGE_WITHOUT_CODE: Message = {
  id: "1b0c4d5e-6f70-4812-93a4-b5c6d7e8f901",
  line: { id: LINE.id, phone: LINE.phone, label: LINE.label },
  from: "+13105550142",
  body: "Hey, are we still on for Thursday?",
  code: null,
  receivedAt: "2026-09-11T10:01:00.000Z",
  service: null,
  contact: null,
  label: null,
};

/**
 * A code read out over an automated call. It arrives as an ordinary message: the
 * transcript in `body`, the calling number in `from`, nothing marking it as a call.
 */
export const CALL_TRANSCRIPT: Message = {
  id: "2c1d5e6f-7081-4923-a4b5-c6d7e8f90123",
  line: { id: LINE.id, phone: LINE.phone, label: null },
  from: "18005550199",
  body: "Your verification code is 5 1 9 2 0 3. Again, 5 1 9 2 0 3.",
  code: "519203",
  receivedAt: "2026-09-11T10:04:10.000Z",
  service: null,
  contact: { id: "ct_1", name: "Payments provider", color: "#1F8A70" },
  label: "Payments provider",
};
