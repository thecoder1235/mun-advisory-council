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

import {
  describeFailure,
  formatAttempts,
  recentAttempts,
  request,
  type Failure,
} from "./http.ts";
import {
  ProviderError,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ProviderConfig,
} from "./types.ts";

/**
 * OpenAI-compatible chat completions across several providers.
 *
 * Model names are configuration, never constants in code — NVIDIA's catalog
 * turns over constantly and a hardcoded id becomes a 404 or 410 without
 * warning.
 */

/**
 * Timeouts.
 *
 * Very generous on purpose. NVIDIA serves these models through Cloud Functions,
 * which scale from zero: when a model is cold the request is queued while a GPU
 * is provisioned, and the connection simply stays open until it is ready.
 * Measured against deepseek-v4-pro from a standing start, a single one-token
 * completion took **111 seconds** — the response carried `nvcf-status:
 * fulfilled`, so it was queueing, not failing.
 *
 * A budget shorter than that turns a working model into a "timeout" the user
 * cannot distinguish from a bad key or a wrong model name. Waiting is cheap;
 * misdiagnosing is not. Progress is shown in the UI so the wait is visible.
 */
export const TIMEOUTS = {
  /** Listing the catalog is a cheap metadata call. */
  models: 30_000,
  /** Just checking the endpoint is reachable. */
  connection: 20_000,
  /** A one-token completion, which may sit in the cold-start queue. */
  verify: 300_000,
  /** A real committee question, on a model that may also be cold. */
  completion: 300_000,
} as const;

export const PROVIDERS: readonly ProviderConfig[] = [
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    // Last-resort fallback only; the live catalog decides in practice.
    defaultModel: "nvidia/llama-3.1-nemotron-70b-instruct",
    requestsPerMinute: 40,
  },
  {
    id: "gemini",
    label: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.0-flash",
    requestsPerMinute: 15,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    requestsPerMinute: 20,
  },
];

export function providerById(id: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Providers that have a usable key, from stored settings or the environment.
 * `apiKeys` is provider id -> key, resolved by the settings layer; the env is
 * only a development fallback.
 */
export function configuredProviders(
  env: NodeJS.ProcessEnv = process.env,
  apiKeys: Readonly<Record<string, string>> = {},
): ProviderConfig[] {
  return PROVIDERS.filter(
    (p) => (apiKeys[p.id] ?? "").trim() !== "" || (env[p.keyEnv] ?? "").trim() !== "",
  );
}

/**
 * A minimum gap between requests to one provider. The agents run in parallel,
 * so without this a single question fires six calls at once and trips the free
 * tier's per-minute ceiling.
 */
const lastCallAt = new Map<string, number>();

async function paceProvider(provider: ProviderConfig): Promise<void> {
  const minGapMs = Math.ceil(60_000 / provider.requestsPerMinute);
  const last = lastCallAt.get(provider.id) ?? 0;
  const wait = last + minGapMs - Date.now();
  lastCallAt.set(provider.id, Math.max(Date.now(), last + minGapMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function probeBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
    stream: false,
  });
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export interface ConnectionTest {
  readonly ok: boolean;
  readonly message: string;
  readonly url: string;
  readonly status?: number;
  readonly elapsedMs: number;
  readonly failureKind?: Failure["kind"];
  /** Proxy variables in the environment, which plain fetch does not honour. */
  readonly proxyEnv: readonly string[];
  readonly requestLog?: string;
}

/**
 * Can we reach the provider at all?
 *
 * Deliberately separate from key and model checks, and deliberately
 * unauthenticated: it answers only "did bytes get there and come back". That
 * makes a network problem distinguishable from a credentials problem instead of
 * both surfacing as the same vague failure.
 */
export async function testConnection(
  provider: ProviderConfig,
  timeoutMs = TIMEOUTS.connection,
): Promise<ConnectionTest> {
  const url = `${provider.baseUrl}/models`;

  // Node's fetch ignores HTTP(S)_PROXY. On a managed or campus network that is
  // a common cause of requests that hang until they time out, so it is worth
  // naming rather than leaving the user to guess.
  const proxyEnv = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"].filter(
    (name) => (process.env[name] ?? "").trim() !== "",
  );

  const before = recentAttempts().length;
  const result = await request(url, { timeoutMs });
  const requestLog = formatAttempts(recentAttempts().slice(before));
  const elapsedMs = result.attempt.elapsedMs;

  if (result.ok || result.failure?.kind === "http") {
    // Any HTTP answer means the network path works, which is all this asks.
    return {
      ok: true,
      url,
      status: result.status ?? 0,
      elapsedMs,
      proxyEnv,
      requestLog,
      message: `Reached ${provider.label} in ${elapsedMs}ms (HTTP ${result.status}).`,
    };
  }

  const failure = result.failure ?? { kind: "other" as const, name: "Error", message: "unknown" };
  const proxyNote =
    proxyEnv.length > 0
      ? ` A proxy is configured in your environment (${proxyEnv.join(", ")}), and this app does not route through it — that is a likely cause.`
      : "";

  return {
    ok: false,
    url,
    elapsedMs,
    proxyEnv,
    requestLog,
    failureKind: failure.kind,
    message: `${describeFailure(failure, timeoutMs)}${proxyNote}`,
  };
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

export interface ModelListResult {
  readonly ok: boolean;
  readonly message: string;
  /** Chat-capable model ids, sorted. Empty when the call failed. */
  readonly models: readonly string[];
  readonly failureKind?: Failure["kind"];
}

/**
 * A provider's model list contains more than chat models. NVIDIA's catalog also
 * carries embedding, reranking and retrieval endpoints, which cannot answer a
 * committee question at all — offering them in a model picker would only invite
 * a confusing failure much later. Anything wrongly excluded is still reachable
 * through the free-text field in settings.
 */
const NON_CHAT_MODEL = /(embed|rerank|retriev|\bocr\b|speech|whisper|tts|image|diffusion|riva)/i;

/**
 * Models worth defaulting to, best first, matched against the live catalog.
 *
 * Patterns rather than fixed ids: the catalog changes underneath us, and a
 * hardcoded id becomes a 410 without warning. Whatever matches first and
 * actually exists today is used.
 */
const PREFERRED_DEFAULTS: Record<string, readonly RegExp[]> = {
  nvidia: [
    /^nvidia\/llama-3\.1-nemotron-70b-instruct$/,
    /nemotron-ultra/,
    /^mistralai\/mistral-large-2-instruct$/,
    /deepseek-v4-pro/,
    /70b-instruct$/,
    /-instruct$/,
  ],
  gemini: [/^gemini-2\.\d-flash$/, /^gemini-.*-flash$/, /^gemini-/],
  openrouter: [/:free$/],
};

/** Pick a sensible default from what the provider actually offers today. */
export function pickDefaultModel(
  providerId: string,
  models: readonly string[],
): string | undefined {
  for (const pattern of PREFERRED_DEFAULTS[providerId] ?? []) {
    const hit = models.find((m) => pattern.test(m));
    if (hit !== undefined) return hit;
  }
  return models[0];
}

/**
 * List the models a key can reach.
 *
 * Model names are configuration, never constants: NVIDIA's catalog turns over
 * constantly, so the list is fetched rather than shipped and can be refreshed
 * without a rebuild.
 */
export async function listModels(
  provider: ProviderConfig,
  apiKey: string,
  timeoutMs = TIMEOUTS.models,
): Promise<ModelListResult> {
  const key = apiKey.trim();
  if (key === "") return { ok: false, message: "No API key set.", models: [] };

  const result = await request(`${provider.baseUrl}/models`, {
    timeoutMs,
    headers: authHeaders(key),
  });

  if (!result.ok) {
    const failure = result.failure;
    if (failure?.kind === "http") {
      if (result.status === 401 || result.status === 403) {
        return {
          ok: false,
          models: [],
          failureKind: "http",
          message: "That key was rejected. Check you copied all of it.",
        };
      }
      return {
        ok: false,
        models: [],
        failureKind: "http",
        message: `${provider.label} returned HTTP ${result.status}.`,
      };
    }
    return {
      ok: false,
      models: [],
      ...(failure === undefined ? {} : { failureKind: failure.kind }),
      message: failure === undefined ? "Request failed." : describeFailure(failure, timeoutMs),
    };
  }

  let models: string[];
  try {
    const data = JSON.parse(result.body ?? "{}") as { data?: Array<{ id?: string }> };
    models = (data.data ?? [])
      .flatMap((m) => (m.id === undefined ? [] : [m.id]))
      .filter((id) => !NON_CHAT_MODEL.test(id))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    return {
      ok: false,
      models: [],
      failureKind: "parse",
      message: `Could not read the model list: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, message: `${models.length} chat model(s) available.`, models };
}

// ---------------------------------------------------------------------------
// Key and model verification
// ---------------------------------------------------------------------------

/**
 * How many models to try before giving up. NVIDIA enables models per account,
 * so the first few picks can all be unavailable to a perfectly good key.
 */
const MAX_PROBE_MODELS = 6;

/** A 404 whose body names the account: the request authenticated, the model did not exist for it. */
const NOT_ENABLED_FOR_ACCOUNT = /not found for account|function not found|account/i;

export interface ProbeAttempt {
  readonly model: string;
  readonly status: number | null;
  readonly note: string;
}

export interface ProbeResult {
  readonly keyValid: boolean;
  readonly workingModel?: string;
  readonly attempts: readonly ProbeAttempt[];
  readonly message: string;
  readonly noModelForAccount: boolean;
  /** Set when the probe could not conclude because requests never completed. */
  readonly inconclusive?: Failure["kind"];
}

/**
 * Verify a key by actually authenticating with it.
 *
 * NVIDIA's `GET /v1/models` is unauthenticated — it returns the full catalog
 * with a garbage key, or with no Authorization header at all — so listing
 * models proves nothing about the key. The only reliable check is a real
 * completion, kept to a single token.
 *
 * The distinctions that matter:
 *
 * - **401/403** — the key itself was rejected.
 * - **404 naming the account** — the key authenticated fine. The request got
 *   far enough for the service to resolve the account and report that *the
 *   model* is not enabled for it. NVIDIA issues keys scoped to particular
 *   models, so this is a normal outcome for a scoped key.
 * - **timeout / network** — nothing was learned at all. Reporting this as a bad
 *   key or a bad model name is a lie that sends the user to fix the wrong thing.
 */
async function probeKey(
  provider: ProviderConfig,
  apiKey: string,
  models: readonly string[],
  timeoutMs: number,
): Promise<ProbeResult> {
  const preferred = pickDefaultModel(provider.id, models);
  const candidates = [preferred, ...models]
    .flatMap((m) => (m === undefined ? [] : [m]))
    .filter((m, i, all) => all.indexOf(m) === i)
    .slice(0, MAX_PROBE_MODELS);

  if (candidates.length === 0) {
    return {
      keyValid: false,
      attempts: [],
      noModelForAccount: false,
      message: `${provider.label} listed no usable models.`,
    };
  }

  const attempts: ProbeAttempt[] = [];
  let sawAccountScoped404 = false;
  let transport: Failure | undefined;

  for (const model of candidates) {
    const result = await request(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: probeBody(model),
      timeoutMs,
      model,
    });

    if (result.ok) {
      return {
        keyValid: true,
        workingModel: model,
        attempts: [...attempts, { model, status: result.status ?? 200, note: "ok" }],
        noModelForAccount: false,
        message: `Key works. Verified against ${model}.`,
      };
    }

    const failure = result.failure;

    // Transport failures teach nothing about the key. Record and move on, so a
    // single cold model does not decide the outcome for the whole probe.
    if (failure && failure.kind !== "http") {
      transport = failure;
      attempts.push({ model, status: null, note: `${failure.kind}: ${failure.name}` });
      continue;
    }

    const status = result.status ?? 0;
    const body = result.body ?? "";

    if (status === 401 || status === 403) {
      return {
        keyValid: false,
        attempts: [...attempts, { model, status, note: "key rejected" }],
        noModelForAccount: false,
        message: "That key was rejected. Check you copied all of it.",
      };
    }
    if (status === 429) {
      return {
        keyValid: true,
        workingModel: model,
        attempts: [...attempts, { model, status, note: "rate-limited" }],
        noModelForAccount: false,
        message: `Key works (currently rate-limited). Verified against ${model}.`,
      };
    }
    if (status === 404 && NOT_ENABLED_FOR_ACCOUNT.test(body)) {
      sawAccountScoped404 = true;
      attempts.push({ model, status: 404, note: "not enabled for this account" });
      continue;
    }
    if (status === 410) {
      attempts.push({ model, status: 410, note: "model retired" });
      continue;
    }
    attempts.push({ model, status, note: body.slice(0, 80) || "unavailable" });
  }

  const tried = attempts.map((a) => a.model).join(", ");

  if (sawAccountScoped404) {
    // Expected, not exceptional. NVIDIA issues keys from each model's own page,
    // and such a key can call that model and nothing else — so a probe over the
    // public catalog is guaranteed to come back empty. Naming the model is the
    // normal way to finish setup, not a fallback for when something failed.
    return {
      keyValid: true,
      attempts,
      noModelForAccount: true,
      message:
        "Key works. NVIDIA issues keys from each model's own page, and this key is tied to one model, " +
        "so it cannot be discovered by probing — enter the model name from the page where you generated it.",
    };
  }

  // Every attempt failed in transport: the key is unproven, not disproven.
  if (transport !== undefined && attempts.every((a) => a.status === null)) {
    return {
      keyValid: false,
      attempts,
      noModelForAccount: false,
      inconclusive: transport.kind,
      message:
        `${describeFailure(transport, timeoutMs)} ` +
        "Nothing was determined about your key or your model — this is a connection problem, not a credentials problem.",
    };
  }

  return {
    keyValid: false,
    attempts,
    noModelForAccount: false,
    message:
      `Could not verify the key: every model tried was unavailable (${tried}). ` +
      "This may be a temporary provider problem rather than a problem with your key.",
  };
}

export interface KeyCheck {
  /** The key authenticated. May be true even when no model is reachable. */
  readonly ok: boolean;
  readonly message: string;
  /** Model ids the provider lists, when it lists any. */
  readonly models?: readonly string[];
  /** A model that actually answered, safe to use as the default. */
  readonly suggestedModel?: string;
  /** False when the key is good but no probed model is enabled for the account. */
  readonly modelReachable?: boolean;
  /** Which models were probed, so the UI can say what was tried. */
  readonly triedModels?: readonly string[];
  readonly attempts?: readonly ProbeAttempt[];
  /**
   * Set when nothing could be concluded because requests timed out or never
   * arrived. The UI must not present this as a rejected key or a wrong model.
   */
  readonly inconclusive?: Failure["kind"];
  /** Raw request log for this check, for the details view. */
  readonly requestLog?: string;
}

/**
 * Check a key before storing it: list what the provider offers, then prove the
 * key actually authenticates.
 */
export async function checkApiKey(
  provider: ProviderConfig,
  apiKey: string,
  timeoutMs = TIMEOUTS.verify,
): Promise<KeyCheck> {
  const key = apiKey.trim();
  if (key === "") return { ok: false, message: "Enter a key first." };

  const before = recentAttempts().length;
  const listed = await listModels(provider, key, TIMEOUTS.models);
  if (!listed.ok) {
    return {
      ok: false,
      message: listed.message,
      ...(listed.failureKind === undefined || listed.failureKind === "http"
        ? {}
        : { inconclusive: listed.failureKind }),
      requestLog: formatAttempts(recentAttempts().slice(before)),
    };
  }

  const probe = await probeKey(provider, key, listed.models, timeoutMs);
  const requestLog = formatAttempts(recentAttempts().slice(before));

  if (!probe.keyValid) {
    return {
      ok: false,
      message: probe.message,
      triedModels: probe.attempts.map((a) => a.model),
      attempts: probe.attempts,
      ...(probe.inconclusive === undefined ? {} : { inconclusive: probe.inconclusive }),
      requestLog,
    };
  }

  const listedNote =
    probe.workingModel === undefined ? "" : ` ${listed.models.length} chat model(s) listed.`;
  return {
    ok: true,
    modelReachable: probe.workingModel !== undefined,
    message: `${probe.message}${listedNote}`,
    models: listed.models,
    triedModels: probe.attempts.map((a) => a.model),
    attempts: probe.attempts,
    requestLog,
    ...(probe.workingModel === undefined ? {} : { suggestedModel: probe.workingModel }),
  };
}

export interface ModelCheck {
  readonly ok: boolean;
  readonly message: string;
  readonly inconclusive?: Failure["kind"];
  readonly requestLog?: string;
}

/**
 * Verify one specific model against a key.
 *
 * Used when the account's models could not be discovered by probing — NVIDIA
 * keys can be scoped to a single model, in which case the user is the only one
 * who knows which. This confirms their answer before it is saved, so a typo
 * surfaces here rather than mid-committee.
 */
export async function verifyModel(
  provider: ProviderConfig,
  apiKey: string,
  model: string,
  timeoutMs = TIMEOUTS.verify,
): Promise<ModelCheck> {
  const id = model.trim();
  if (id === "") return { ok: false, message: "Enter a model id first." };

  const before = recentAttempts().length;
  const result = await request(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: probeBody(id),
    timeoutMs,
    model: id,
  });
  const requestLog = formatAttempts(recentAttempts().slice(before));

  if (result.ok) return { ok: true, message: `${id} works.`, requestLog };

  const failure = result.failure;
  if (failure && failure.kind !== "http") {
    // Timed out or never arrived: say so, and do not blame the model name.
    return {
      ok: false,
      inconclusive: failure.kind,
      message: `${describeFailure(failure, timeoutMs)} The model name has not been ruled out — nothing was verified either way.`,
      requestLog,
    };
  }

  const status = result.status ?? 0;
  if (status === 429) {
    return { ok: true, message: `${id} works (currently rate-limited).`, requestLog };
  }
  if (status === 401 || status === 403) {
    return { ok: false, message: "The stored key was rejected. Re-enter it above.", requestLog };
  }
  if (status === 404) {
    return {
      ok: false,
      message: `"${id}" is not available to your account. Copy the model string exactly as it appears on the page where you generated the key.`,
      requestLog,
    };
  }
  if (status === 410) {
    return { ok: false, message: `"${id}" has been retired by the provider.`, requestLog };
  }
  return { ok: false, message: `HTTP ${status}: ${(result.body ?? "").slice(0, 160)}`, requestLog };
}

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  readonly choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  readonly usage?: { prompt_tokens?: number; completion_tokens?: number };
  readonly error?: { message?: string; code?: string };
}

async function callProvider(
  provider: ProviderConfig,
  req: CompletionRequest,
  env: NodeJS.ProcessEnv,
  apiKeys: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<{ text: string; model: string; usage: ChatCompletionResponse["usage"] }> {
  const key = (apiKeys[provider.id] ?? env[provider.keyEnv] ?? "").trim();
  if (key === "") {
    throw new ProviderError(provider.id, `no API key for ${provider.label}`, { retryable: false });
  }

  const model = req.model ?? provider.defaultModel;
  await paceProvider(provider);

  const result = await request(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 2048,
      stream: false,
    }),
    timeoutMs,
    model,
  });

  if (!result.ok) {
    const failure = result.failure;
    // A timeout is worth retrying; a rejected key is not.
    if (failure && failure.kind !== "http") {
      throw new ProviderError(provider.id, describeFailure(failure, timeoutMs), {
        retryable: failure.kind === "timeout" || failure.kind === "network",
      });
    }
    const status = result.status ?? 0;
    throw new ProviderError(provider.id, `HTTP ${status}: ${(result.body ?? "").slice(0, 300)}`, {
      status,
      retryable: status === 429 || status >= 500,
    });
  }

  let data: ChatCompletionResponse;
  try {
    data = JSON.parse(result.body ?? "{}") as ChatCompletionResponse;
  } catch (err) {
    throw new ProviderError(provider.id, `unreadable response: ${String(err)}`, { retryable: true });
  }

  if (data.error) {
    throw new ProviderError(provider.id, data.error.message ?? "unknown API error", {
      retryable: false,
    });
  }

  const text = data.choices?.[0]?.message?.content ?? "";
  if (text.trim() === "") {
    throw new ProviderError(provider.id, "empty completion", { retryable: true });
  }
  return { text, model, usage: data.usage };
}

export interface CompleteOptions {
  /** Provider order to try. Defaults to every provider with a key set. */
  readonly providers?: readonly ProviderConfig[];
  readonly retriesPerProvider?: number;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Provider id -> key, from user settings. Takes precedence over the env. */
  readonly apiKeys?: Readonly<Record<string, string>>;
  readonly onAttempt?: (note: string) => void;
}

/**
 * Try each provider in order, retrying with backoff on transient failures and
 * falling through to the next provider when one is exhausted.
 */
export async function complete(
  req: CompletionRequest,
  opts: CompleteOptions = {},
): Promise<CompletionResult> {
  const env = opts.env ?? process.env;
  const apiKeys = opts.apiKeys ?? {};
  const chain = opts.providers ?? configuredProviders(env, apiKeys);
  const retries = opts.retriesPerProvider ?? 2;
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.completion;

  if (chain.length === 0) {
    throw new Error("no provider configured — add an API key in Settings");
  }

  const fellBackFrom: string[] = [];
  const failures: string[] = [];

  for (const provider of chain) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        const backoff = 1000 * 2 ** (attempt - 1);
        opts.onAttempt?.(`${provider.label}: retry ${attempt} in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }

      const started = Date.now();
      try {
        opts.onAttempt?.(`${provider.label}: calling ${req.model ?? provider.defaultModel}`);
        const { text, model, usage } = await callProvider(provider, req, env, apiKeys, timeoutMs);
        return {
          text,
          provider: provider.id,
          model,
          elapsedMs: Date.now() - started,
          fellBackFrom: [...fellBackFrom],
          ...(usage?.prompt_tokens === undefined ? {} : { promptTokens: usage.prompt_tokens }),
          ...(usage?.completion_tokens === undefined
            ? {}
            : { completionTokens: usage.completion_tokens }),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.onAttempt?.(`${provider.label}: ${message}`);
        const retryable = err instanceof ProviderError ? err.retryable : false;
        if (!retryable || attempt === retries) {
          failures.push(`${provider.label}: ${message}`);
          break;
        }
      }
    }
    fellBackFrom.push(provider.id);
  }

  throw new Error(`all providers failed:\n  ${failures.join("\n  ")}`);
}

export { clearAttempts, formatAttempts, recentAttempts } from "./http.ts";
export type { Failure, FailureKind, HttpAttempt } from "./http.ts";
export type { ChatMessage, CompletionRequest, CompletionResult, ProviderConfig };
export { ProviderError };
