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

/* ============================================================================
 * THIS TOOL SPENDS REAL API CREDITS AND REAL TIME.
 *
 * It runs against your configured provider using the API key stored in the
 * app's profile, and every model call is billed against your rate limit. On the
 * default NVIDIA free tier a single model call takes roughly two minutes,
 * because the model cold-starts on essentially every request.
 *
 * Approximate cost: ~5 minutes, up to 7 model calls (key and model probes).
 *
 * Nothing in this directory is needed to build, test or contribute to the
 * project. For that, use the free offline suites in `test/` instead:
 *
 *     npm test              every offline suite, no network, no cost
 *
 * ==========================================================================*/

/**
 * Run the real verification path inside Electron, against the real profile, and
 * dump every request it made.
 *
 *   npm run diagnose
 *   npm run diagnose -- --model nvidia/llama-3.1-nemotron-70b-instruct
 *
 * Must run under Electron rather than plain Node: the stored key is encrypted
 * with the OS keystore via safeStorage, which only exists inside Electron. This
 * is the same code path the settings screen uses — not a re-implementation.
 *
 * No top-level await: Electron does not emit `ready` until the main module has
 * finished evaluating, so awaiting at the top level deadlocks with no output.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import electron from "electron";

import { profileCandidates } from "./profile-dir.mjs";

const { app, safeStorage } = electron;

/**
 * Point at the profile the app actually writes to.
 *
 * Electron derives userData from the app name, and the app name depends on how
 * Electron was launched: `electron .` reads package.json, while
 * `electron scripts/diagnose.mjs` falls back to "Electron". Without this the
 * diagnostic would inspect an empty profile and report no key — which is
 * exactly what a user would misread as "my key was lost".
 */
const profileArg = process.argv.indexOf("--profile");
const candidates =
  profileArg !== -1 && process.argv[profileArg + 1]
    ? [process.argv[profileArg + 1]]
    : profileCandidates();
const chosen = candidates.find((dir) => existsSync(join(dir, "settings.json"))) ?? candidates[0];
app.setPath("userData", chosen);

const LOG = process.env.MUN_DIAGNOSE_LOG ?? "diagnose.log";
writeFileSync(LOG, "");
const out = (line = "") => {
  appendFileSync(LOG, `${line}\n`);
  console.log(line);
};

process.on("uncaughtException", (err) => {
  appendFileSync(LOG, `UNCAUGHT: ${err?.stack ?? err}\n`);
  app.exit(1);
});
process.on("unhandledRejection", (err) => {
  appendFileSync(LOG, `REJECTED: ${err?.stack ?? err}\n`);
  app.exit(1);
});

app.whenReady().then(async () => {
  const providers = await import("../dist/providers/index.js");
  const store = await import("../dist/settings/store.js");

  const { PROVIDERS, providerById, testConnection, listModels, checkApiKey, verifyModel, formatAttempts, clearAttempts, TIMEOUTS } =
    providers;

  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const provider = providerById(flag("provider") ?? "nvidia");
  const userData = app.getPath("userData");

  out("MUN Advisory Council — in-app diagnostics");
  out("=========================================");
  out(`electron   : ${process.versions.electron}  (node ${process.versions.node})`);
  out(`app name   : ${app.getName()}`);
  out(`userData   : ${userData}`);
  out(`candidates : ${candidates.join("  |  ")}`);
  out(`provider   : ${provider.label}  ${provider.baseUrl}`);
  out(
    `timeouts   : connection ${TIMEOUTS.connection / 1000}s · models ${TIMEOUTS.models / 1000}s · verify ${TIMEOUTS.verify / 1000}s`,
  );

  const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "NO_PROXY"]
    .filter((n) => (process.env[n] ?? "").trim() !== "")
    .map((n) => `${n}=${process.env[n]}`);
  out(`proxy env  : ${proxyVars.length > 0 ? proxyVars.join(", ") : "(none set)"}`);

  // Electron resolves the system proxy even though fetch will not use it.
  try {
    const resolved = await electron.session.defaultSession.resolveProxy(provider.baseUrl);
    out(`system proxy for ${provider.baseUrl}: ${resolved}`);
  } catch {
    out("system proxy: (could not resolve)");
  }

  // --- the stored key ------------------------------------------------------
  out("\n1. STORED KEY");
  out("-------------");
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  const codec = encryptionAvailable
    ? {
        scheme: "safeStorage-v1",
        encrypt: (v) => safeStorage.encryptString(v).toString("base64"),
        decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret.value, "base64")),
      }
    : store.PLAINTEXT_CODEC;

  out(`OS encryption available : ${encryptionAvailable}`);
  const settings = await store.loadSettings(userData);
  const stored = settings.providers?.[provider.id]?.apiKey;
  out(`stored secret scheme    : ${stored?.scheme ?? "(none stored)"}`);

  const resolvedKey = store.resolveProviderKey(settings, provider.id, provider.keyEnv, codec);
  if (!resolvedKey) {
    out("RESULT: no usable key. Nothing further can be tested.");
    app.exit(1);
    return;
  }
  // Only ever the shape, never the key.
  out(`key source              : ${resolvedKey.source}`);
  out(`key length              : ${resolvedKey.key.length} chars`);
  out(`key prefix              : ${resolvedKey.key.slice(0, 6)}…${resolvedKey.key.slice(-4)}`);
  out(`decrypted cleanly       : yes`);
  out(`globalModel in settings : ${settings.globalModel ?? "(unset)"}`);
  out(`agentModels             : ${JSON.stringify(settings.agentModels ?? {})}`);

  const key = resolvedKey.key;

  // --- reachability --------------------------------------------------------
  out("\n2. CONNECTION (no key, no model)");
  out("--------------------------------");
  clearAttempts();
  const conn = await testConnection(provider);
  out(`${conn.ok ? "PASS" : "FAIL"}  ${conn.message}`);
  out(`      ${conn.url} — ${conn.elapsedMs}ms`);
  out("\n   raw:");
  out(formatAttempts());

  // --- catalog -------------------------------------------------------------
  out("\n3. MODEL CATALOG (key sent)");
  out("---------------------------");
  clearAttempts();
  const listed = await listModels(provider, key);
  out(`${listed.ok ? "PASS" : "FAIL"}  ${listed.message}`);
  if (listed.ok) out(`      first 8: ${listed.models.slice(0, 8).join(", ")}`);
  out("\n   raw:");
  out(formatAttempts());

  // --- the failing step ----------------------------------------------------
  out("\n4. KEY VERIFICATION — the actual completion requests");
  out("----------------------------------------------------");
  clearAttempts();
  const started = Date.now();
  const check = await checkApiKey(provider, key);
  out(`${check.ok ? "PASS" : "FAIL"}  ${check.message}`);
  out(`      took ${Math.round((Date.now() - started) / 1000)}s`);
  if (check.inconclusive) out(`      INCONCLUSIVE (${check.inconclusive}) — key neither proven nor disproven`);
  if (check.attempts?.length) {
    out("      per-model outcome:");
    for (const a of check.attempts) {
      out(`        ${a.model}  ->  ${a.status ?? "no response"}  ${a.note}`);
    }
  }
  out("\n   raw (every completion request, with status and body):");
  out(formatAttempts());

  // --- a specific model ----------------------------------------------------
  const wanted = flag("model") ?? settings.globalModel;
  if (wanted) {
    out(`\n5. SINGLE MODEL — ${wanted}`);
    out("-".repeat(20 + wanted.length));
    clearAttempts();
    const t = Date.now();
    const mc = await verifyModel(provider, key, wanted);
    out(`${mc.ok ? "PASS" : "FAIL"}  ${mc.message}`);
    out(`      took ${Math.round((Date.now() - t) / 1000)}s`);
    if (mc.inconclusive) out(`      INCONCLUSIVE (${mc.inconclusive})`);
    out("\n   raw:");
    out(formatAttempts());
  } else {
    out("\n5. SINGLE MODEL — skipped (no model configured; pass --model <id>)");
  }

  out(`\nWritten to ${LOG}. No API key appears above.`);
  app.exit(0);
});
