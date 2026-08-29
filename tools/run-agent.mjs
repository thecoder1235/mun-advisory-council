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
 * Approximate cost: ~2-4 minutes, 1 model call (a single agent).
 *
 * Nothing in this directory is needed to build, test or contribute to the
 * project. For that, use the free offline suites in `test/` instead:
 *
 *     npm test              every offline suite, no network, no cost
 *
 * ==========================================================================*/

/**
 * Run one agent end to end inside Electron, using the key stored in the app.
 *
 *   npm run agent:app -- --ask "..." --character "Doctor Doom"
 *
 * The CLI equivalent cannot do this: the stored key is encrypted with the OS
 * keystore, which only exists inside Electron.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import electron from "electron";

import { profileCandidates } from "./profile-dir.mjs";

const { app, safeStorage } = electron;

const candidates = profileCandidates();
app.setPath("userData", candidates.find((d) => existsSync(join(d, "settings.json"))) ?? candidates[0]);

const LOG = process.env.MUN_AGENT_LOG ?? "agent-run.log";
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
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const CHARACTERS = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--character") CHARACTERS.push(argv[i + 1]);
}
if (CHARACTERS.length === 0) CHARACTERS.push("Doctor Doom");

const AGENT = flag("agent", "canon-keeper");
const ASK = flag("ask", "Which of my weaknesses can be exploited at this table, and how?");

app.whenReady().then(async () => {
  const store = await import("../dist/settings/store.js");
  const { PROVIDERS, providerById, formatAttempts, clearAttempts } = await import(
    "../dist/providers/index.js"
  );
  const { fetchCharacter } = await import("../dist/wiki/index.js");
  const { runAgent } = await import("../dist/agents/run.js");
  const { auditGrounding } = await import("../dist/cli/grounding.js");

  const provider = providerById("nvidia");
  const codec = safeStorage.isEncryptionAvailable()
    ? {
        scheme: "safeStorage-v1",
        encrypt: (v) => safeStorage.encryptString(v).toString("base64"),
        decrypt: (s) => safeStorage.decryptString(Buffer.from(s.value, "base64")),
      }
    : store.PLAINTEXT_CODEC;

  const settings = await store.loadSettings(app.getPath("userData"));
  const apiKeys = store.resolveAllKeys(settings, PROVIDERS, codec);
  if (!apiKeys[provider.id]) {
    out("No usable key in the app profile.");
    app.exit(1);
    return;
  }

  const model = store.modelForAgent(settings, AGENT);
  out(`agent      : ${AGENT}`);
  out(`characters : ${CHARACTERS.join(", ")}`);
  out(`question   : ${ASK}`);
  out(`model      : ${model ?? "(provider default)"}`);
  out(`profile    : ${app.getPath("userData")}`);

  // 1. Fetch.
  out(`\nFETCH`);
  out("-----");
  const dossiers = [];
  for (const name of CHARACTERS) {
    const dossier = await fetchCharacter(name);
    dossiers.push(dossier);
    for (const r of dossier.results) {
      if (r.status === "found") {
        out(
          `  OK    [${r.page.canon}] ${r.wiki.label}: ${r.page.resolvedTitle} ` +
            `(${r.page.extract.length.toLocaleString()} chars${r.fromCache ? ", cache" : ""})`,
        );
      } else if (r.status === "missing") {
        out(`  NONE  [${r.wiki.canon}] ${r.wiki.label}: ${r.reason} — ${r.detail}`);
      } else {
        out(`  FAIL  [${r.wiki.canon}] ${r.wiki.label}: ${r.error}`);
      }
    }
  }

  // 2. Run.
  out(`\nRUN`);
  out("---");
  clearAttempts();
  const started = Date.now();
  let run;
  try {
    run = await runAgent({
      agent: AGENT,
      question: ASK,
      dossiers,
      apiKeys,
      ...(model === undefined ? {} : { model }),
      onAttempt: (note) => out(`  ${note}`),
    });
  } catch (err) {
    out(`FAILED: ${err?.message ?? err}`);
    out("\nraw requests:");
    out(formatAttempts());
    app.exit(1);
    return;
  }

  const { completion, source } = run;
  out(`  elapsed: ${Math.round((Date.now() - started) / 1000)}s`);
  out(`  source block: ${source.totalChars.toLocaleString()} chars, ${source.gaps.length} gap(s) declared`);
  for (const gap of source.gaps) out(`    gap: ${gap}`);
  out(
    `  provider: ${completion.provider} · model: ${completion.model} · ` +
      `${completion.promptTokens ?? "?"} prompt / ${completion.completionTokens ?? "?"} completion tokens`,
  );

  out(`\n${"=".repeat(70)}`);
  out("RAW MODEL OUTPUT (verbatim)");
  out("=".repeat(70));
  out(completion.text);

  out(`\n${"=".repeat(70)}`);
  out("GROUNDING AUDIT");
  out("=".repeat(70));
  const audit = auditGrounding(completion.text, source.text);
  const line = (ok, label, detail) => out(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(26)} ${detail}`);

  line(
    audit.hasAllHeadings,
    "four standard headings",
    audit.missingHeadings.length === 0 ? "all present" : `missing: ${audit.missingHeadings.join(", ")}`,
  );
  line(audit.canonTagCount > 0, "canon tags used", `${audit.canonTagCount} tag(s): ${audit.canonTagBreakdown}`);
  line(true, "[UNVERIFIED] markers", `${audit.unverifiedCount} used`);
  line(!audit.hasFlattery, "no flattery opener", audit.hasFlattery ? "opens with praise" : "clean");

  out(`\n  Proper nouns in the answer NOT found in the source text (${audit.unsupportedNames.length}):`);
  if (audit.unsupportedNames.length === 0) {
    out("    none — every name in the answer occurs in the fetched text");
  } else {
    for (const name of audit.unsupportedNames) {
      out(`    ${audit.unverifiedNames.has(name) ? "[marked UNVERIFIED]" : "[UNMARKED]        "} ${name}`);
    }
  }

  out(`\n  raw requests:`);
  out(formatAttempts());
  out(`\nWritten to ${LOG}.`);
  app.exit(0);
});
