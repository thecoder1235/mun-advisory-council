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
 * Run one agent end to end against real fetched wiki text.
 *
 *   npm run agent -- "Doctor Doom" --ask "What can be used against me?"
 *   npm run agent -- "Doctor Doom" "Thanos" --agent vulnerability-mapper --ask "..."
 *   npm run agent -- "Doctor Doom" --show-source --show-prompt
 *
 * Flags:
 *   --ask "<question>"   the delegate's question (required)
 *   --agent <name>       canon-keeper (default) or vulnerability-mapper
 *   --model <id>         per-agent model override
 *   --provider <id>      force one provider instead of the fallback chain
 *   --language <name>    output language (default English)
 *   --show-source        print the assembled source block
 *   --show-prompt        print the full system directive
 *   --refresh            bypass the wiki cache
 */

import { runAgent } from "../agents/run.ts";
import { configuredProviders, PROVIDERS, providerById } from "../providers/index.ts";
import {
  defaultUserDataDir,
  loadSettings,
  modelForAgent,
  orderedProviders,
  resolveAllKeys,
  PLAINTEXT_CODEC,
} from "../settings/store.ts";
import { fetchCharacter } from "../wiki/index.ts";
import type { CharacterDossier } from "../wiki/types.ts";
import { auditGrounding } from "./grounding.ts";

const COLOR = process.stdout.isTTY === true && !process.env["NO_COLOR"];
const c = {
  dim: (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (COLOR ? `\x1b[36m${s}\x1b[0m` : s),
};

interface Args {
  names: string[];
  ask: string;
  agent: string;
  model?: string;
  provider?: string;
  language: string;
  showSource: boolean;
  showPrompt: boolean;
  refresh: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    names: [],
    ask: "",
    agent: "canon-keeper",
    language: "English",
    showSource: false,
    showPrompt: false,
    refresh: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error(c.red(`${arg} needs a value`));
        process.exit(2);
      }
      i += 1;
      return value;
    };

    if (arg === "--ask") args.ask = next();
    else if (arg === "--agent") args.agent = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--provider") args.provider = next();
    else if (arg === "--language") args.language = next();
    else if (arg === "--show-source") args.showSource = true;
    else if (arg === "--show-prompt") args.showPrompt = true;
    else if (arg === "--refresh") args.refresh = true;
    else if (arg.startsWith("--")) {
      console.error(c.red(`unknown flag: ${arg}`));
      process.exit(2);
    } else args.names.push(arg);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.names.length === 0 || args.ask === "") {
    console.error('usage: npm run agent -- "<character>" [more...] --ask "<question>" [--agent <name>]');
    process.exit(2);
  }

  // Same resolution order as the app: stored settings first, .env second.
  // Keys the app encrypted with the OS keystore cannot be read from outside
  // Electron, so on a dev machine this falls through to .env, as intended.
  const userDataDir = defaultUserDataDir();
  const settings = await loadSettings(userDataDir);
  const apiKeys = resolveAllKeys(settings, PROVIDERS, PLAINTEXT_CODEC);

  const available = configuredProviders(process.env, apiKeys);
  if (available.length === 0) {
    console.error(c.red("No provider key found. Either:"));
    console.error(`  - run the app and enter a key on the setup screen (stored in ${userDataDir})`);
    console.error("  - or create a .env file with one of:");
    for (const p of PROVIDERS) console.error(`      ${p.keyEnv}=   (${p.label}, default model ${p.defaultModel})`);
    process.exit(2);
  }

  // Honour the fallback order the settings screen wrote, restricted to
  // providers that actually have a key.
  const chain =
    args.provider === undefined
      ? orderedProviders(settings, available, apiKeys)
      : [providerById(args.provider)].flatMap((p) => (p ? [p] : []));
  if (chain.length === 0) {
    console.error(c.red(`unknown provider: ${args.provider}`));
    process.exit(2);
  }

  // 1. Fetch.
  console.log(c.bold(`\nFetching ${args.names.length} character(s)`));
  const dossiers: CharacterDossier[] = [];
  for (const name of args.names) {
    const dossier = await fetchCharacter(name, { refresh: args.refresh });
    dossiers.push(dossier);
    for (const r of dossier.results) {
      if (r.status === "found") {
        const alts = r.page.resolution.alternatives;
        console.log(
          `  ${c.green("OK  ")} ${name} — [${r.page.canon}] ${r.wiki.label}: ${c.bold(r.page.resolvedTitle)} ` +
            c.dim(`(${r.page.extract.length.toLocaleString()} chars${r.fromCache ? ", cache" : ""})`),
        );
        if (alts.length > 0) console.log(c.dim(`         alternatives: ${alts.slice(0, 4).join(" | ")}`));
      } else if (r.status === "missing") {
        console.log(`  ${c.yellow("NONE")} ${name} — [${r.wiki.canon}] ${r.wiki.label}: ${c.dim(r.reason)}`);
      } else {
        console.log(`  ${c.red("FAIL")} ${name} — [${r.wiki.canon}] ${r.wiki.label}: ${c.dim(r.error)}`);
      }
    }
  }

  // 2. Run the agent. --model wins, then the per-role choice saved in the app,
  // then the provider's own default.
  const model = args.model ?? modelForAgent(settings, args.agent);
  console.log(
    c.bold(`\nRunning ${args.agent}`) +
      c.dim(model === undefined ? " (provider default model)" : ` on ${model}`),
  );
  const run = await runAgent({
    agent: args.agent,
    question: args.ask,
    dossiers,
    apiKeys,
    providers: chain,
    onAttempt: (note) => console.log(c.dim(`  ${note}`)),
    ...(model === undefined ? {} : { model }),
    outputLanguage: args.language,
  });

  if (args.showPrompt) {
    console.log(c.bold("\n=== SYSTEM DIRECTIVE ===\n"));
    console.log(run.directive);
  }
  if (args.showSource) {
    console.log(c.bold("\n=== SOURCE BLOCK ===\n"));
    console.log(run.source.text);
  }

  console.log(
    c.dim(
      `\n  source block: ${run.source.totalChars.toLocaleString()} chars, ${run.source.gaps.length} gap(s) declared`,
    ),
  );
  for (const gap of run.source.gaps) console.log(c.dim(`    gap: ${gap}`));

  const { completion } = run;
  console.log(
    c.dim(
      `  provider: ${completion.provider} · model: ${completion.model} · ${completion.elapsedMs}ms` +
        (completion.promptTokens === undefined
          ? ""
          : ` · ${completion.promptTokens} prompt / ${completion.completionTokens} completion tokens`) +
        (completion.fellBackFrom.length > 0 ? ` · fell back from ${completion.fellBackFrom.join(", ")}` : ""),
    ),
  );

  // 3. Raw output, verbatim.
  console.log(c.bold("\n=== RAW MODEL OUTPUT ===\n"));
  console.log(completion.text);

  // 4. Mechanical grounding audit.
  console.log(c.bold("\n=== GROUNDING AUDIT ===\n"));
  const audit = auditGrounding(completion.text, run.source.text);

  const line = (ok: boolean, label: string, detail: string): void => {
    console.log(`  ${ok ? c.green("PASS") : c.red("FAIL")}  ${label.padEnd(28)} ${c.dim(detail)}`);
  };

  line(audit.hasAllHeadings, "four standard headings", audit.missingHeadings.length === 0 ? "all present" : `missing: ${audit.missingHeadings.join(", ")}`);
  line(audit.canonTagCount > 0, "canon tags used", `${audit.canonTagCount} tag(s): ${audit.canonTagBreakdown}`);
  line(true, "[UNVERIFIED] markers", `${audit.unverifiedCount} used`);
  line(!audit.hasFlattery, "no flattery opener", audit.hasFlattery ? "opens with banned praise" : "clean");

  console.log();
  console.log(c.cyan(`  Proper nouns in the answer that do NOT appear in the source text (${audit.unsupportedNames.length}):`));
  if (audit.unsupportedNames.length === 0) {
    console.log(c.dim("    none — every name in the answer occurs in the fetched text"));
  } else {
    for (const name of audit.unsupportedNames) {
      console.log(`    ${audit.unverifiedNames.has(name) ? c.dim("[marked UNVERIFIED]") : c.red("[unmarked]      ")} ${name}`);
    }
    console.log(
      c.dim("\n    Unmarked entries are candidates for invention — check each against the page before trusting it."),
    );
  }
  console.log();
}

main().catch((err: unknown) => {
  console.error(c.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
