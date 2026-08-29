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
 * Diagnose provider connectivity, keys and models — and print the raw requests.
 *
 *   npm run doctor
 *   npm run doctor -- --model nvidia/llama-3.1-nemotron-70b-instruct
 *   npm run doctor -- --provider gemini
 *
 * Runs the checks in order of what they can rule out:
 *   1. Can we reach the provider at all?  (no key, no model)
 *   2. Does the key authenticate?         (key only)
 *   3. Does a specific model answer?      (key + model)
 *
 * Every request is printed with its URL, status, elapsed time and raw body, so
 * a timeout is visibly a timeout rather than something to guess at.
 */

import {
  checkApiKey,
  formatAttempts,
  PROVIDERS,
  providerById,
  testConnection,
  TIMEOUTS,
  verifyModel,
} from "../providers/index.ts";
import {
  defaultUserDataDir,
  loadSettings,
  modelForAgent,
  resolveAllKeys,
  PLAINTEXT_CODEC,
} from "../settings/store.ts";

const COLOR = process.stdout.isTTY === true && !process.env["NO_COLOR"];
const c = {
  dim: (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
};

function heading(text: string): void {
  console.log(`\n${c.bold(text)}`);
  console.log(c.dim("-".repeat(text.length)));
}

function verdict(ok: boolean, message: string): void {
  console.log(`${ok ? c.green("PASS") : c.red("FAIL")}  ${message}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const providerId = flag("provider") ?? "nvidia";
  const provider = providerById(providerId);
  if (!provider) {
    console.error(`unknown provider: ${providerId}. Known: ${PROVIDERS.map((p) => p.id).join(", ")}`);
    process.exit(2);
  }

  const userDataDir = defaultUserDataDir();
  const settings = await loadSettings(userDataDir);
  const apiKeys = resolveAllKeys(settings, PROVIDERS, PLAINTEXT_CODEC);
  const key = apiKeys[provider.id];

  console.log(c.bold(`\nMUN Advisory Council — provider diagnostics`));
  console.log(c.dim(`provider:  ${provider.label} (${provider.baseUrl})`));
  console.log(c.dim(`settings:  ${userDataDir}`));
  console.log(
    c.dim(
      `timeouts:  connection ${TIMEOUTS.connection / 1000}s · models ${TIMEOUTS.models / 1000}s · verify ${TIMEOUTS.verify / 1000}s · completion ${TIMEOUTS.completion / 1000}s`,
    ),
  );

  const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "NO_PROXY"]
    .filter((n) => (process.env[n] ?? "").trim() !== "")
    .map((n) => `${n}=${process.env[n]}`);
  console.log(c.dim(`proxy env: ${proxyVars.length > 0 ? proxyVars.join(", ") : "(none set)"}`));

  // 1. Reachability. No key, no model — this can only fail on the network.
  heading("1. Connection");
  const conn = await testConnection(provider);
  verdict(conn.ok, conn.message);
  console.log(c.dim(`      ${conn.url} — ${conn.elapsedMs}ms`));
  if (conn.proxyEnv.length > 0) {
    console.log(
      c.yellow(
        `      Note: ${conn.proxyEnv.join(", ")} is set. Node's fetch ignores proxy variables, so requests bypass it.`,
      ),
    );
  }
  if (!conn.ok) {
    console.log(c.yellow("\n      The provider is unreachable, so nothing below can be trusted."));
    console.log(c.yellow("      This is a network problem, not a key or model problem."));
  }

  // 2. The key.
  heading("2. API key");
  if (key === undefined || key.trim() === "") {
    console.log(c.yellow("SKIP  No key available to this CLI."));
    console.log(
      c.dim(
        "      Keys saved in the app are encrypted with the OS keystore and cannot be read from outside Electron.",
      ),
    );
    console.log(c.dim(`      For CLI use, put ${provider.keyEnv}=... in a .env file.`));
  } else {
    console.log(c.dim(`      using key from ${provider.keyEnv} (…${key.slice(-6)})`));
    const check = await checkApiKey(provider, key);
    verdict(check.ok, check.message);
    if (check.inconclusive) {
      console.log(
        c.yellow(`      Inconclusive (${check.inconclusive}) — the key was neither proven nor disproven.`),
      );
    }
    if (check.attempts && check.attempts.length > 0) {
      console.log(c.dim("      models probed:"));
      for (const a of check.attempts) {
        console.log(c.dim(`        ${a.model}  ->  ${a.status ?? "no response"}  ${a.note}`));
      }
    }
  }

  // 3. A specific model.
  const wanted = flag("model") ?? modelForAgent(settings, "canon-keeper");
  heading("3. Model");
  if (key === undefined || key.trim() === "") {
    console.log(c.yellow("SKIP  needs a key."));
  } else if (wanted === undefined) {
    console.log(c.yellow("SKIP  no model configured. Pass --model <id> to test one."));
  } else {
    console.log(c.dim(`      testing ${wanted}`));
    const check = await verifyModel(provider, key, wanted);
    verdict(check.ok, check.message);
    if (check.inconclusive) {
      console.log(c.yellow(`      Inconclusive (${check.inconclusive}) — the model name was not ruled out.`));
    }
  }

  // 4. Everything that was actually sent.
  heading("4. Raw requests");
  console.log(formatAttempts());
  console.log(
    c.dim("\n(No API keys appear above — only URLs, statuses, timings and response bodies.)\n"),
  );
}

main().catch((err: unknown) => {
  console.error(c.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
