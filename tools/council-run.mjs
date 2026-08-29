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
 * Approximate cost: ~9 minutes, 7 model calls (a full council run).
 *
 * Nothing in this directory is needed to build, test or contribute to the
 * project. For that, use the free offline suites in `test/` instead:
 *
 *     npm test              every offline suite, no network, no cost
 *
 * ==========================================================================*/

/**
 * Full council run inside Electron with the stored key.
 *
 *   npm run council -- --character "Doctor Doom" --ask "..."
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import electron from "electron";

import { profileCandidates } from "./profile-dir.mjs";

const { app, safeStorage } = electron;

const candidates = profileCandidates();
app.setPath("userData", candidates.find((d) => existsSync(join(d, "settings.json"))) ?? candidates[0]);

const LOG = "council-run.log";
writeFileSync(LOG, "");
const out = (line = "") => {
  appendFileSync(LOG, `${line}\n`);
  console.log(line);
};

process.on("uncaughtException", (e) => {
  appendFileSync(LOG, `UNCAUGHT: ${e?.stack ?? e}\n`);
  app.exit(1);
});
process.on("unhandledRejection", (e) => {
  appendFileSync(LOG, `REJECTED: ${e?.stack ?? e}\n`);
  app.exit(1);
});

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const CHARACTERS = [];
for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--character") CHARACTERS.push(argv[i + 1]);
if (CHARACTERS.length === 0) CHARACTERS.push("Doctor Doom");
const ASK = flag("ask", "Which of my weaknesses can be exploited at this table, and how?");

app.whenReady().then(async () => {
  const store = await import("../dist/settings/store.js");
  const { PROVIDERS } = await import("../dist/providers/index.js");
  const { fetchCharacter } = await import("../dist/wiki/index.js");
  const { runCouncil } = await import("../dist/council/run.js");
  const { ALL_AGENTS } = await import("../dist/council/router.js");

  const codec = safeStorage.isEncryptionAvailable()
    ? {
        scheme: "safeStorage-v1",
        encrypt: (v) => safeStorage.encryptString(v).toString("base64"),
        decrypt: (s) => safeStorage.decryptString(Buffer.from(s.value, "base64")),
      }
    : store.PLAINTEXT_CODEC;

  const settings = await store.loadSettings(app.getPath("userData"));
  const apiKeys = store.resolveAllKeys(settings, PROVIDERS, codec);
  const chain = store.orderedProviders(settings, PROVIDERS, apiKeys);
  if (chain.length === 0) {
    out("no provider configured");
    app.exit(1);
    return;
  }

  const models = { router: store.modelForAgent(settings, "router") };
  for (const a of ALL_AGENTS) models[a] = store.modelForAgent(settings, a);

  out(`question   : ${ASK}`);
  out(`characters : ${CHARACTERS.join(", ")}`);
  out(`model      : ${models.router ?? "(default)"}`);

  const dossiers = [];
  for (const name of CHARACTERS) dossiers.push(await fetchCharacter(name));

  const started = Date.now();
  const answer = await runCouncil({
    question: ASK,
    dossiers,
    apiKeys,
    providers: chain,
    models,
    outputLanguage: settings.outputLanguage,
    onEvent: (e) => {
      const t = Math.round((Date.now() - started) / 1000);
      if (e.type === "router") {
        out(`\n[${t}s] ROUTER -> ${e.decision.outcome}`);
        if (e.decision.outcome === "proceed") {
          out(`        woke: ${e.decision.agents.map((a) => a.name).join(", ")}`);
          for (const a of e.decision.agents) if (a.focus) out(`        ${a.name}: ${a.focus}`);
          if (e.decision.corrections.length) out(`        ENFORCED: ${e.decision.corrections.join("; ")}`);
        }
      } else if (e.type === "agent-start") out(`[${t}s] start  ${e.agent}`);
      else if (e.type === "agent-done") {
        out(
          `[${t}s] done   ${e.result.agent}  ${e.result.error ? "ERROR: " + e.result.error : `${Math.round(e.result.elapsedMs / 1000)}s, ${e.result.completionTokens ?? "?"} tokens`}`,
        );
      } else if (e.type === "note") out(`[${t}s] note   ${e.text}`);
    },
  });

  out(`\ntotal: ${Math.round((Date.now() - started) / 1000)}s`);
  out(`outcome: ${answer.outcome}`);
  out(`gaps: ${answer.gaps.length}`);
  for (const g of answer.gaps) out(`  - ${g}`);

  out(`\n${"=".repeat(70)}\nHEADLINE (coordinator)\n${"=".repeat(70)}`);
  out(answer.headline ?? "(none)");

  for (const r of answer.results) {
    if (r.agent === "coordinator") continue;
    out(`\n${"=".repeat(70)}\n${r.agent.toUpperCase()}${r.focus ? `  — focus: ${r.focus}` : ""}\n${"=".repeat(70)}`);
    out(r.error ? `ERROR: ${r.error}` : r.text);
  }

  out(`\nWritten to ${LOG}.`);
  app.exit(0);
});
