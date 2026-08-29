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
 * Regression tests for a real leak: an API key pasted into the model-name field
 * was sent as a model id and then printed verbatim by the request log.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const secrets = (await import("../src/providers/secrets.ts")) as any;
const providers = (await import("../src/providers/index.ts")) as any;
const http = (await import("../src/providers/http.ts")) as any;

let fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
};

// Shaped like a real key so the pattern matching is genuinely exercised, but
// self-evidently fake so no secret scanner — or reader — mistakes it for one.
const FAKE_KEY = "nvapi-EXAMPLE0NOT0A0REAL0KEY0000000000000000000000000000000000000000";

// --- 1. Recognising a key where a model name belongs ------------------------
check("recognises an NVIDIA key", secrets.looksLikeApiKey(FAKE_KEY) === true);
check("recognises an sk- key", secrets.looksLikeApiKey("sk-abcdefghijklmnopqrstuvwxyz012345") === true);
check("recognises a Google key", secrets.looksLikeApiKey("AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q") === true);
check("recognises a truncated paste", secrets.looksLikeApiKey("nvapi-") === true);
check("recognises a key with surrounding whitespace", secrets.looksLikeApiKey(`  ${FAKE_KEY}  `) === true);

// Model ids are long and hyphenated too; none may be mistaken for a key.
for (const model of [
  "deepseek-ai/deepseek-v4-pro-0813",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "meta-llama/llama-3.3-70b-instruct:free",
  "gemini-2.0-flash",
  "mistralai/mistral-large-2-instruct",
]) {
  check(`real model id accepted: ${model}`, secrets.looksLikeApiKey(model) === false);
}
check("empty string is not a key", secrets.looksLikeApiKey("") === false);

// --- 2. Redaction -----------------------------------------------------------
const red = secrets.redactSecrets(`model=${FAKE_KEY} failed`);
check("redacts a bare key", !red.includes(FAKE_KEY), red);
check("redaction leaves a visible marker", red.includes("[REDACTED-API-KEY]"), red);
check(
  "redacts a bearer header",
  !secrets.redactSecrets(`Authorization: Bearer ${FAKE_KEY}`).includes(FAKE_KEY),
);
check(
  "leaves a genuine model id intact",
  secrets.redactSecrets("model=deepseek-ai/deepseek-v4-pro-0813") ===
    "model=deepseek-ai/deepseek-v4-pro-0813",
);
check("undefined passes through", secrets.redactSecrets(undefined) === undefined);

// --- 3. The reported failure: verifyModel must not send or log the key ------
const before = providers.formatAttempts();
const result = await providers.verifyModel(
  providers.providerById("nvidia"),
  FAKE_KEY,
  FAKE_KEY, // the mistake: key pasted into the model field
);
check("a key as a model name is refused", result.ok === false);
check("the refusal names the mistake", /looks like your API key/i.test(result.message), result.message.slice(0, 60));
check("the refusal says nothing was sent", /nothing was sent/i.test(result.message));
check("no request was made at all", providers.formatAttempts() === before);
check("the key is absent from the refusal message", !result.message.includes(FAKE_KEY));

// --- 4. Redaction holds even if validation is bypassed ----------------------
// Drive the logger directly with a key in the model field, the way the old code
// did, and confirm the log no longer carries it.
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  // Echo the key back too, as a provider error message might.
  res.end(JSON.stringify({ detail: `no such model ${FAKE_KEY}` }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

http.clearAttempts();
await http.request(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${FAKE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: FAKE_KEY }),
  timeoutMs: 5000,
  model: FAKE_KEY,
});

const log = http.formatAttempts();
check("log does not contain the key in the model field", !log.includes(FAKE_KEY), log.slice(0, 160));
check("log shows the redaction marker instead", log.includes("[REDACTED-API-KEY]"));
check(
  "a key echoed back in the response body is redacted too",
  !JSON.stringify(http.recentAttempts()).includes(FAKE_KEY),
);

server.close();

console.log(fail === 0 ? "\nAll secret-handling checks passed." : `\n${fail} failed.`);
process.exitCode = fail === 0 ? 0 : 1;
