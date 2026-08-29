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
 * Manual verification harness for the fetch layer.
 *
 *   npm run wiki -- "Doctor Doom"
 *   npm run wiki -- "Batman" "Thanos" --refresh
 *   npm run wiki -- "Vision" --full
 *   npm run wiki -- "Darkseid" --json
 *
 * Flags:
 *   --refresh     ignore the cache, hit the network, rewrite the cache
 *   --full        print the whole extract instead of a preview
 *   --preview=N   preview length in characters (default 320)
 *   --json        dump the raw dossier as JSON, nothing else
 */

import { fetchCharacter, getCacheRoot } from "../wiki/index.ts";
import type { CharacterDossier, WikiResult } from "../wiki/types.ts";

const COLOR = process.stdout.isTTY === true && !process.env["NO_COLOR"];
const c = {
  dim: (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (COLOR ? `\x1b[36m${s}\x1b[0m` : s),
  magenta: (s: string) => (COLOR ? `\x1b[35m${s}\x1b[0m` : s),
};

interface Args {
  names: string[];
  refresh: boolean;
  full: boolean;
  json: boolean;
  preview: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { names: [], refresh: false, full: false, json: false, preview: 320 };
  for (const arg of argv) {
    if (arg === "--refresh" || arg === "--no-cache") args.refresh = true;
    else if (arg === "--full") args.full = true;
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("--preview=")) {
      const n = Number.parseInt(arg.slice("--preview=".length), 10);
      if (Number.isFinite(n) && n > 0) args.preview = n;
    } else if (arg.startsWith("--")) {
      console.error(c.red(`unknown flag: ${arg}`));
      process.exit(2);
    } else args.names.push(arg);
  }
  return args;
}

function canonTag(canon: string): string {
  return canon === "COMICS" ? c.magenta(`[${canon}]`) : c.cyan(`[${canon}]`);
}

function printResult(result: WikiResult, args: Args): void {
  const label = result.wiki.label.padEnd(28);

  if (result.status === "found") {
    const { page } = result;
    const source = result.fromCache ? c.dim("cache") : c.dim("network");
    console.log(
      `  ${c.green("OK  ")} ${label} ${canonTag(page.canon)} ${c.bold(page.resolvedTitle)} ` +
        `${c.dim(`(${page.extract.length.toLocaleString()} chars, ${source})`)}`,
    );
    if (page.resolution.viaDisambiguation !== undefined) {
      console.log(
        `       ${c.dim(`via disambiguation page "${page.resolution.picked}"`)}`,
      );
    }
    console.log(`       ${c.dim(page.url)}`);
    const text = page.extract.replace(/\s+/g, " ").trim();
    const body = args.full ? page.extract : text.slice(0, args.preview) + (text.length > args.preview ? "..." : "");
    for (const line of body.split("\n")) console.log(`       ${c.dim(line)}`);
    console.log();
    return;
  }

  if (result.status === "missing") {
    console.log(
      `  ${c.yellow("NONE")} ${label} ${canonTag(result.wiki.canon)} ${c.yellow("no page")} ` +
        `${c.dim(`(${result.reason}) ${result.detail}`)}`,
    );
    console.log();
    return;
  }

  console.log(
    `  ${c.red("FAIL")} ${label} ${canonTag(result.wiki.canon)} ${c.red(result.error)}`,
  );
  console.log();
}

function printSummary(dossier: CharacterDossier): void {
  const found = dossier.results.filter((r) => r.status === "found");
  const missing = dossier.results.filter((r) => r.status === "missing");
  const errored = dossier.results.filter((r) => r.status === "error");

  console.log(`  ${c.bold("Summary")}`);
  console.log(
    `    retrieved: ${found.length}/${dossier.results.length}` +
      (found.length > 0
        ? c.dim(` — ${found.map((r) => (r.status === "found" ? `${r.page.canon}:${r.page.resolvedTitle}` : "")).join(", ")}`)
        : ""),
  );
  if (missing.length > 0) {
    console.log(
      `    ${c.yellow("no page on")}: ${missing.map((r) => r.wiki.label).join(", ")}`,
    );
    console.log(
      c.dim("    (these gaps must be surfaced to the delegate, never filled in by the model)"),
    );
  }
  if (errored.length > 0) {
    console.log(`    ${c.red("failed")}: ${errored.map((r) => r.wiki.label).join(", ")}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.names.length === 0) {
    console.error("usage: npm run wiki -- \"<character name>\" [more names...] [--refresh] [--full] [--json] [--preview=N]");
    process.exit(2);
  }

  const dossiers: CharacterDossier[] = [];
  for (const name of args.names) {
    if (!args.json) {
      console.log();
      console.log(c.bold(`${name}`) + c.dim(`  —  sweeping 4 wikis`));
      console.log();
    }
    const dossier = await fetchCharacter(name, { refresh: args.refresh });
    dossiers.push(dossier);
    if (!args.json) {
      for (const result of dossier.results) printResult(result, args);
      printSummary(dossier);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(dossiers.length === 1 ? dossiers[0] : dossiers, null, 2));
    return;
  }

  console.log(c.dim(`cache: ${getCacheRoot()}`));

  const anyError = dossiers.some((d) => d.results.some((r) => r.status === "error"));
  if (anyError) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(c.red(err instanceof Error ? err.stack ?? err.message : String(err)));
  process.exit(1);
});
