import OpenAI from "openai"; // imported for its typed error classes (APIError and friends)

// Every failure gets a named kind, because every kind has a different recovery
// strategy and a different retry budget. "Error rate is up" takes hours to
// debug; "rate_limited jumped from 0 to 5%" takes minutes.
export enum ApiErrorKind {
  Network = "network", // connection refused, DNS failure, socket reset...
  Timeout = "timeout", // the request itself timed out
  RateLimited = "rate_limited", // 429 — the server is telling us to back off
  ServerError = "server_error", // 5xx — their problem, worth retrying
  ContextTooLong = "context_too_long", // the conversation no longer fits the window
  AuthFailed = "auth_failed", // 401/403 — retrying will never help
  BadRequest = "bad_request", // other 4xx — our request is malformed
  Aborted = "aborted", // the user cancelled (Ctrl+C)
  Unknown = "unknown", // anything we have not seen yet — retry cautiously
}

// What the rest of the app gets back: a bucket, a retry verdict, the raw text.
export interface ClassifiedError {
  kind: ApiErrorKind; // which bucket this failure belongs to
  retryable: boolean; // is another attempt worth anything at all?
  message: string; // the original error text, for logs and user display
}

// Providers phrase "your input is too big" in many ways — match loosely.
const CONTEXT_TOO_LONG_RE = /context.*length|maximum.*(context|length|tokens)|too (long|large)|exceed/i;

// Translate whatever the SDK throws into exactly one ClassifiedError.
export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err); // normalize: not everything thrown is an Error

  // User cancellation. The SDK has a dedicated class for it, but an aborted
  // fetch can also surface as a plain Error named "AbortError" — catch both.
  if (err instanceof OpenAI.APIUserAbortError || (err instanceof Error && err.name === "AbortError")) {
    return { kind: ApiErrorKind.Aborted, retryable: false, message }; // not an error to recover from
  }
  // Timeout is checked before Network because it is a subclass of it.
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return { kind: ApiErrorKind.Timeout, retryable: true, message }; // slow network — try again
  }
  // Could not reach the server at all (DNS, connection refused, reset...).
  if (err instanceof OpenAI.APIConnectionError) {
    return { kind: ApiErrorKind.Network, retryable: true, message }; // transient — try again
  }
  // The server answered with an error — classify by HTTP status code.
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0; // some APIError instances carry no status — treat as 0
    if (status === 429) return { kind: ApiErrorKind.RateLimited, retryable: true, message }; // server says: back off
    if (status === 401 || status === 403) return { kind: ApiErrorKind.AuthFailed, retryable: false, message }; // bad key — retries are useless
    if (status === 400 && CONTEXT_TOO_LONG_RE.test(message)) {
      return { kind: ApiErrorKind.ContextTooLong, retryable: false, message }; // needs compaction, not retries
    }
    if (status >= 500) return { kind: ApiErrorKind.ServerError, retryable: true, message }; // their side broke — retry
    if (status >= 400) return { kind: ApiErrorKind.BadRequest, retryable: false, message }; // our request is wrong — don't
  }
  // Default for the unknown: retry, but it still consumes the budgets —
  // an unknown error that keeps happening will trip the circuit breaker.
  return { kind: ApiErrorKind.Unknown, retryable: true, message };
}
