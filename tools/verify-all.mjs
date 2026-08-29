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
 * Approximate cost: ~20-40 MINUTES and 20+ model calls. The most expensive
 * tool here; it runs full councils across several scenarios.
 *
 * Nothing in this directory is needed to build, test or contribute to the
 * project. For that, use the free offline suites in `test/` instead:
 *
 *     npm test              every offline suite, no network, no cost
 *
 * ==========================================================================*/

/**
 * End-to-end verification against the live provider, using the stored key.
 *
 *   npm run verify              all scenarios
 *   npm run verify -- --only router
 *
 * Scenarios are ordered cheapest first, so a run that is cut short still
 * produces the results that cost least to get.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import electron from "electron";

import { resolveProfileDir } from "./profile-dir.mjs";

const { app, safeStorage } = electron;

app.setPath("userData", resolveProfileDir());

const LOG = "verify.log";
writeFileSync(LOG, "");
const out = (l = "") => {
  appendFileSync(LOG, `${l}\n`);
  console.log(l);
};

process.on("uncaughtException", (e) => {
  appendFileSync(LOG, `UNCAUGHT: ${e?.stack ?? e}\n`);
  app.exit(1);
});
process.on("unhandledRejection", (e) => {
  appendFileSync(LOG, `REJECTED: ${e?.stack ?? e}\n`);
  app.exit(1);
});

let failures = 0;
const check = (n, ok, d = "") => {
  if (!ok) failures += 1;
  out(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
};

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf("--only");
const ONLY = onlyIdx === -1 ? null : argv[onlyIdx + 1];
const want = (name) => ONLY === null || ONLY === name;

/** The four headings and marker rules every agent must follow. */
function checkFormat(label, text) {
  const headings = ["Finding", "Where this breaks", "Recommendation", "If I'm wrong"];
  const missing = headings.filter(
    (h) => !new RegExp(`\\*{0,2}${h.replace(/'/g, "['’]")}\\*{0,2}`, "i").test(text),
  );
  check(`${label}: four headings`, missing.length === 0, missing.join(", ") || "all present");

  const tags = (text.match(/\[(COMICS|FILM|BOTH)\]/g) ?? []).length;
  check(`${label}: canon tags used`, tags > 0, `${tags} tags`);

  // "Where this breaks" may never be empty or filled with praise.
  const wtb = /where this breaks\**\s*:?\s*\n([\s\S]{0,400})/i.exec(text);
  check(`${label}: "Where this breaks" not empty`, (wtb?.[1] ?? "").trim().length > 20);

  const flattery = /^\s*(great|good|excellent|strong|nice)\b/i.test(text);
  check(`${label}: no flattery opener`, !flattery);
}

app.whenReady().then(async () => {
  const store = await import("../dist/settings/store.js");
  const { PROVIDERS } = await import("../dist/providers/index.js");
  const { fetchCharacter } = await import("../dist/wiki/index.js");
  const { runCouncil } = await import("../dist/council/run.js");
  const { route, ALL_AGENTS } = await import("../dist/council/router.js");
  const { buildSourceBlock } = await import("../dist/agents/source-text.js");
  const { selectSections, SECTION_PROFILES, SECTION_BUDGETS } = await import("../dist/wiki/sections.js");

  const codec = safeStorage.isEncryptionAvailable()
    ? {
        scheme: "safeStorage-v1",
        encrypt: (v) => safeStorage.encryptString(v).toString("base64"),
        decrypt: (s) => safeStorage.decryptString(Buffer.from(s.value, "base64")),
      }
    : store.PLAINTEXT_CODEC;

  const settings = await store.loadSettings(app.getPath("userData"));
  const apiKeys = store.resolveAllKeys(settings, PROVIDERS, codec);
  const providers = store.orderedProviders(settings, PROVIDERS, apiKeys);
  const models = { router: store.modelForAgent(settings, "router") };
  for (const a of ALL_AGENTS) models[a] = store.modelForAgent(settings, a);

  out(`model: ${models.router}\n`);

  // ---------------------------------------------------------------- ROUTER --
  if (want("router")) {
    out("=== 1. ROUTER PATHS (no agent should wake) ===");
    const cases = [
      ["hello", "greeting"],
      ["how do I use this", "help"],
      ["what's the weather", "off_topic"],
    ];
    for (const [input, expected] of cases) {
      const t = Date.now();
      const d = await route({ question: input, characters: [], model: models.router, apiKeys, providers });
      out(`  "${input}" -> ${d.outcome} (${Math.round((Date.now() - t) / 1000)}s)`);
      check(`"${input}" routes to ${expected}`, d.outcome === expected, d.outcome);
      check(`"${input}" wakes nobody`, d.agents.length === 0, `${d.agents.length} agents`);
      if (d.reply) out(`     reply: ${d.reply.slice(0, 120)}`);
    }

    // The help answer must come from the user guide on disk, not the model.
    const { loadPrompt } = await import("../dist/agents/loader.js");
    const guide = await loadPrompt("user-guide");
    check("user-guide.md loads from disk", guide.length > 200, `${guide.length} chars`);
    out("");
  }

  // ------------------------------------------------------- SECTION BUDGETS --
  if (want("sections")) {
    out("=== 2. SECTION BUDGET (all five, Weaknesses present) ===");
    const doom = await fetchCharacter("Doctor Doom");
    const page = doom.results.find((r) => r.status === "found" && r.wiki.id === "marvel-comics");
    const sel = selectSections(page.page.extract, SECTION_PROFILES["canon-keeper"], SECTION_BUDGETS["canon-keeper"]);
    const names = sel.included.map((s) => s.name);
    out(`  included: ${names.join(", ")}`);
    out(`  missing : ${sel.missing.join(", ") || "(none)"}`);
    check("all five sections present", names.length === 5, names.join(","));
    check("Weaknesses present", names.includes("Weaknesses"));
    check("History present", names.includes("History"));
    check("nothing dropped for budget", !sel.missing.some((m) => m.includes("budget")));

    const block = buildSourceBlock("canon-keeper", [doom]);
    check("source block declares Weaknesses to the agent", /Weaknesses/.test(block.text));
    out("");
  }

  // ------------------------------------------------- MULTI-CHARACTER BUDGET --
  if (want("multi")) {
    out("=== 3. FOUR CHARACTERS, vulnerability-mapper budget ===");
    const names = ["Doctor Doom", "Thanos", "Magneto", "Joker"];
    const dossiers = [];
    for (const n of names) dossiers.push(await fetchCharacter(n));
    const block = buildSourceBlock("vulnerability-mapper", dossiers);
    out(`  source block: ${block.totalChars.toLocaleString()} chars for ${names.length} characters`);
    out(`  gaps: ${block.gaps.length}`);
    // Four characters at 6k each is the design ceiling; well under a context limit.
    check("multi-character block stays bounded", block.totalChars < 40_000, `${block.totalChars} chars`);
    check("every character appears in the block", names.every((n) => block.text.includes(n)));
    check("gaps are declared per character", block.gaps.length > 0, `${block.gaps.length} gaps`);
    out("");
  }

  // ------------------------------------------------------- FULL COUNCIL A ---
  if (want("council")) {
    out("=== 4. FULL COUNCIL — Doctor Doom weaknesses ===");
    const doom = await fetchCharacter("Doctor Doom");
    const t = Date.now();
    const answer = await runCouncil({
      question: "Which of my weaknesses can be exploited at this table, and how?",
      dossiers: [doom],
      apiKeys,
      providers,
      models,
      onEvent: (e) => {
        if (e.type === "agent-done") {
          out(`    ${e.result.agent}: ${e.result.error ? "ERROR " + e.result.error.slice(0, 60) : Math.round(e.result.elapsedMs / 1000) + "s"}`);
        }
      },
    });
    out(`  total ${Math.round((Date.now() - t) / 1000)}s, outcome=${answer.outcome}`);
    check("council proceeded", answer.outcome === "proceed");
    check("coordinator produced a headline", (answer.headline ?? "").length > 200);
    const keeper = answer.results.find((r) => r.agent === "canon-keeper");
    check("canon-keeper ran", keeper !== undefined && !keeper.error);
    if (keeper && !keeper.error) {
      // The whole point of the budget fix: weaknesses must reach the agent.
      check(
        "canon-keeper no longer reports a budget-dropped section",
        !/not retrieved due to budget|no budget left/i.test(keeper.text),
        (/not retrieved due to budget|no budget left/i.exec(keeper.text) ?? [""])[0],
      );
      checkFormat("canon-keeper", keeper.text);
    }
    out("");
  }

  // ------------------------------------------ FORECASTER / STRATEGIST -------
  if (want("agents")) {
    out("=== 5. crisis-forecaster + alliance-strategist ===");
    const doom = await fetchCharacter("Doctor Doom");
    const thor = await fetchCharacter("Thor");
    const t = Date.now();
    const answer = await runCouncil({
      question: "Thor just joined the table. What changes for me, and what might the chair throw at us next?",
      dossiers: [doom, thor],
      apiKeys,
      providers,
      models,
      forceAgents: ["crisis-forecaster", "alliance-strategist"],
      onEvent: (e) => {
        if (e.type === "agent-done") {
          out(`    ${e.result.agent}: ${e.result.error ? "ERROR " + e.result.error.slice(0, 60) : Math.round(e.result.elapsedMs / 1000) + "s"}`);
        }
      },
    });
    out(`  total ${Math.round((Date.now() - t) / 1000)}s`);

    for (const name of ["crisis-forecaster", "alliance-strategist"]) {
      const r = answer.results.find((x) => x.agent === name);
      check(`${name} ran`, r !== undefined, r ? "ran" : "missing");
      if (r && !r.error) checkFormat(name, r.text);
      else if (r?.error) out(`    ${name} error: ${r.error}`);
    }
    out("");
  }

  // ------------------------------------------------------- RESILIENCE -------
  if (want("resilience")) {
    out("=== 6. ONE AGENT FAILS — council must still answer ===");
    const doom = await fetchCharacter("Doctor Doom");
    // Point one agent at a model that does not exist: it fails fast with 404
    // while the others run normally.
    const brokenModels = { ...models, "vulnerability-mapper": "definitely/not-a-real-model" };
    const t = Date.now();
    const answer = await runCouncil({
      question: "Which of my weaknesses can be exploited at this table?",
      dossiers: [doom],
      apiKeys,
      providers,
      models: brokenModels,
      forceAgents: ["vulnerability-mapper"],
      onEvent: (e) => {
        if (e.type === "agent-done") {
          out(`    ${e.result.agent}: ${e.result.error ? "ERROR" : Math.round(e.result.elapsedMs / 1000) + "s"}`);
        }
      },
    });
    out(`  total ${Math.round((Date.now() - t) / 1000)}s`);

    const broken = answer.results.find((r) => r.agent === "vulnerability-mapper");
    check("the broken agent failed", broken?.error !== undefined, broken?.error?.slice(0, 70));
    check("the council still finished", answer.outcome === "proceed");
    check("the coordinator still produced an answer", (answer.headline ?? "").length > 200);
    check("failed agents are recorded for retry", (answer.failedAgents ?? []).includes("vulnerability-mapper"));
    check(
      "the coordinator says which reading is missing",
      /vulnerability|missing|did not|unavailable|failed/i.test(answer.headline ?? ""),
      (answer.headline ?? "").slice(0, 100),
    );
    out("");
  }

  out(failures === 0 ? "ALL VERIFICATION CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
