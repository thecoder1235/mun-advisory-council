/*
 * MUN Advisory Council — grounded multi-agent preparation for Model UN crisis committees.
 * Copyright (C) 2026 MUN Advisory Council contributors
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
 * details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * One place where every provider request is made, timed, classified and
 * recorded.
 *
 * The point is diagnosability. When a call fails, "invalid key" and "request
 * timed out" are completely different problems with completely different fixes,
 * and a layer that collapses them into one message sends people to fix things
 * that were never broken. So the failure kind is decided here, once, from the
 * actual error — never inferred later from a string.
 */

export type FailureKind =
  /** The request did not complete within its budget. Says nothing about the key. */
  | "timeout"
  /** DNS, TLS, refused connection, proxy: the request never reached the provider. */
  | "network"
  /** The provider answered with a non-2xx status. */
  | "http"
  /** The provider answered, but not with JSON we could read. */
  | "parse"
  | "other";

export interface Failure {
  readonly kind: FailureKind;
  readonly name: string;
  readonly message: string;
}

/** A single request, recorded for the diagnostics view. Never contains the key. */
export interface HttpAttempt {
  readonly at: string;
  readonly method: string;
  readonly url: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly status?: number;
  readonly ok: boolean;
  readonly failure?: Failure;
  /** First part of the response body, for reading the provider's own wording. */
  readonly bodySnippet?: string;
}

export interface HttpResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly body?: string;
  readonly attempt: HttpAttempt;
  readonly failure?: Failure;
}

const LOG_LIMIT = 60;
const log: HttpAttempt[] = [];

function record(attempt: HttpAttempt): HttpAttempt {
  log.push(attempt);
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  return attempt;
}

/** Most recent requests, newest last. Safe to show the user: no keys are stored. */
export function recentAttempts(limit = LOG_LIMIT): readonly HttpAttempt[] {
  return log.slice(-limit);
}

export function clearAttempts(): void {
  log.length = 0;
}

/** Render the log as plain text the user can copy into a bug report. */
export function formatAttempts(attempts: readonly HttpAttempt[] = recentAttempts()): string {
  if (attempts.length === 0) return "(no requests made yet)";
  return attempts
    .map((a) => {
      const head = `${a.method} ${a.url}${a.model === undefined ? "" : `  model=${a.model}`}`;
      const outcome = a.failure
        ? `${a.failure.kind.toUpperCase()} (${a.failure.name}): ${a.failure.message}`
        : `HTTP ${a.status}`;
      const body = a.bodySnippet ? `\n     body: ${a.bodySnippet}` : "";
      return `  ${a.at}\n     ${head}\n     ${outcome}  [${a.elapsedMs}ms of ${a.timeoutMs}ms budget]${body}`;
    })
    .join("\n");
}

interface CauseLike {
  code?: string;
  message?: string;
  errors?: unknown[];
  cause?: unknown;
}

/** Walk nested causes and AggregateError lists for the first real error code. */
function findErrorCode(cause: unknown, depth = 0): string | undefined {
  if (cause === null || typeof cause !== "object" || depth > 4) return undefined;
  const node = cause as CauseLike;
  if (typeof node.code === "string") return node.code;
  for (const nested of node.errors ?? []) {
    const found = findErrorCode(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return findErrorCode(node.cause, depth + 1);
}

function classify(err: unknown): Failure {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);

  // AbortSignal.timeout rejects with a TimeoutError; an explicit abort with an
  // AbortError. Both mean "took too long", never "bad credentials".
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "timeout", name, message };
  }

  // undici wraps connection problems in a generic "fetch failed" TypeError. The
  // useful part — ENOTFOUND, ECONNREFUSED, a certificate error — is nested in
  // `cause`, and when several addresses were tried it is nested again inside an
  // AggregateError's `errors`. Surfacing "TypeError" instead of "ECONNREFUSED"
  // would waste the one detail that actually tells the user what to fix.
  const cause = err instanceof Error ? (err.cause as CauseLike | undefined) : undefined;
  const rootCode = findErrorCode(cause);
  if (message.includes("fetch failed") || rootCode !== undefined) {
    // Prefer the error code, then the cause's own wording. "TypeError: fetch
    // failed" is the one description that tells the user nothing at all.
    const label = rootCode ?? cause?.message ?? message;
    return { kind: "network", name: label, message: String(cause?.message ?? label) };
  }

  return { kind: "other", name, message };
}

export interface RequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs: number;
  /** Recorded alongside the request so the log reads usefully. */
  readonly model?: string;
}

/** Make one request, recording exactly what happened. Never throws. */
export async function request(url: string, opts: RequestOptions): Promise<HttpResult> {
  const method = opts.method ?? "GET";
  const started = Date.now();

  const base = {
    at: new Date().toISOString(),
    method,
    url,
    timeoutMs: opts.timeoutMs,
    ...(opts.model === undefined ? {} : { model: opts.model }),
  };

  try {
    const res = await fetch(url, {
      method,
      ...(opts.headers === undefined ? {} : { headers: opts.headers }),
      ...(opts.body === undefined ? {} : { body: opts.body }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    const body = await res.text().catch(() => "");
    const attempt = record({
      ...base,
      elapsedMs: Date.now() - started,
      status: res.status,
      ok: res.ok,
      ...(body === "" ? {} : { bodySnippet: body.slice(0, 300) }),
      ...(res.ok ? {} : { failure: { kind: "http" as const, name: `HTTP ${res.status}`, message: body.slice(0, 200) } }),
    });

    return res.ok
      ? { ok: true, status: res.status, body, attempt }
      : {
          ok: false,
          status: res.status,
          body,
          attempt,
          failure: { kind: "http", name: `HTTP ${res.status}`, message: body.slice(0, 200) },
        };
  } catch (err) {
    const failure = classify(err);
    const attempt = record({ ...base, elapsedMs: Date.now() - started, ok: false, failure });
    return { ok: false, attempt, failure };
  }
}

/** Human wording for a non-HTTP failure, kept out of key- and model-blaming language. */
export function describeFailure(failure: Failure, timeoutMs: number): string {
  switch (failure.kind) {
    case "timeout":
      return (
        `The request timed out after ${Math.round(timeoutMs / 1000)}s. ` +
        "This is not a problem with your key or the model name — the provider did not answer in time. " +
        "NVIDIA provisions a GPU on first use, which has been measured at nearly two minutes for a large " +
        'model, so a retry is usually faster. Use "Test connection" if you suspect the network.'
      );
    case "network":
      return (
        `Could not reach the provider (${failure.name}). ` +
        `The request never got there, so this says nothing about your key. ` +
        `Check your connection, VPN, or proxy.`
      );
    case "parse":
      return `The provider replied with something unreadable: ${failure.message}`;
    default:
      return `${failure.name}: ${failure.message}`;
  }
}
