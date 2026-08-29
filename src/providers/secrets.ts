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
 * Keeping API keys out of anything the app displays or logs.
 *
 * Two independent defences, because either one alone has failed in practice:
 *
 * 1. **Refuse a key where a model name belongs.** The setup flow asks for a key
 *    and then a model name, in that order, from the same clipboard. Pasting the
 *    key twice is the obvious mistake, and until it is caught the key is sent
 *    as a model id.
 * 2. **Redact on the way into the request log regardless.** The log records the
 *    model of every request, so a key that reached the model field was printed
 *    in full by "Show request details", `npm run doctor` and the diagnostics in
 *    `tools/`. Validation should stop that, but the log must not depend on
 *    validation being correct — it is the last place a secret should surface.
 */

/**
 * Key shapes worth recognising.
 *
 * Deliberately matched by prefix and length rather than by trying to identify
 * "anything secret-looking": a model id like `deepseek-ai/deepseek-v4-pro-0813`
 * is long and hyphenated too, and a redactor that eats model names would make
 * the log useless for the debugging it exists to support.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // NVIDIA NIM
  /nvapi-[A-Za-z0-9_-]{8,}/g,
  // OpenAI / OpenRouter and the many providers that copied the shape
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Google AI Studio
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  // Anything already framed as a bearer token
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

/** What a redacted secret is replaced with, kept recognisable on purpose. */
const MASK = "[REDACTED-API-KEY]";

/**
 * Remove anything key-shaped from text bound for a log, a UI panel or an error
 * message. Safe to call on undefined.
 */
export function redactSecrets<T extends string | undefined>(text: T): T {
  if (text === undefined) return text;
  let out = text as string;
  for (const pattern of SECRET_PATTERNS) {
    // Fresh lastIndex each call: these are module-level /g regexes.
    pattern.lastIndex = 0;
    out = out.replace(pattern, MASK);
  }
  return out as T;
}

/**
 * Does this look like an API key rather than a model name?
 *
 * Used to reject a key pasted into the model field before any request is made,
 * so it never reaches the network, the settings file or the log.
 */
export function looksLikeApiKey(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;

  // A prefix match is enough on its own — no legitimate model id begins this
  // way, so this catches a truncated or partially-pasted key too.
  if (/^(nvapi-|sk-|AIza|gsk_)/i.test(trimmed)) return true;

  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(trimmed);
  });
}

/**
 * The message shown when a key is entered as a model name.
 *
 * Names the mistake precisely: the person has not typed something invalid, they
 * have typed the right value into the wrong box, and telling them which box
 * saves the round trip.
 */
export function apiKeyInModelFieldMessage(): string {
  return (
    "That looks like your API key, not a model name. " +
    "The key goes in the API key field above; this field wants the model id from " +
    "the page you generated the key on, for example deepseek-ai/deepseek-v4-pro-0813. " +
    "Nothing was sent."
  );
}
