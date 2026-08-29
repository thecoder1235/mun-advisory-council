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
 * Durability tests for the settings write path — the failure that lost a real
 * API key mid-session.
 */
const store = (await import("../src/settings/store.ts")) as any;

const { mkdtemp, rm, readFile, writeFile, readdir, stat } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

let fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
};

const dir = await mkdtemp(join(tmpdir(), "mun-durability-"));
const codec = store.PLAINTEXT_CODEC;

const withKey = (k: string) =>
  store.setProviderKey(store.DEFAULT_SETTINGS ?? { version: 1, providers: {}, providerOrder: [], agentModels: {}, outputLanguage: "English" }, "nvidia", k, codec);

// --- 1. Basic round trip ----------------------------------------------------
await store.saveSettings(dir, withKey("nvapi-first"));
let loaded = await store.loadSettings(dir);
check("saves and reloads a key", loaded.providers.nvidia?.apiKey?.value === "nvapi-first");

// --- 2. A backup appears once there is something to back up -----------------
await store.saveSettings(dir, withKey("nvapi-second"));
const files = await readdir(dir);
check("backup copy is written", files.includes("settings.backup.json"), files.join(", "));
const backup = JSON.parse(await readFile(join(dir, "settings.backup.json"), "utf8"));
check("backup holds the PREVIOUS value, not the current one",
  backup.providers.nvidia.apiKey.value === "nvapi-first", backup.providers.nvidia.apiKey.value);

// --- 3. The actual reported failure: settings.json vanishes -----------------
await rm(join(dir, "settings.json"));
loaded = await store.loadSettings(dir, { onRecover: (d: string) => console.log("      recover:", d.slice(0, 60)) });
check("a DELETED settings file recovers from backup",
  loaded.providers.nvidia?.apiKey?.value === "nvapi-first", loaded.providers.nvidia?.apiKey?.value ?? "(none)");
check("recovery restores the file to disk", (await readdir(dir)).includes("settings.json"));

// --- 4. Truncated / half-written file ---------------------------------------
await writeFile(join(dir, "settings.json"), "");
loaded = await store.loadSettings(dir);
check("an EMPTY settings file recovers from backup",
  loaded.providers.nvidia?.apiKey?.value === "nvapi-first", loaded.providers.nvidia?.apiKey?.value ?? "(none)");

await writeFile(join(dir, "settings.json"), '{"version":1,"providers":{"nvidia":{"apiK');
loaded = await store.loadSettings(dir);
check("a TRUNCATED settings file recovers from backup",
  loaded.providers.nvidia?.apiKey?.value === "nvapi-first", loaded.providers.nvidia?.apiKey?.value ?? "(none)");

// --- 5. Concurrent writes must not corrupt ----------------------------------
// The original bug: every writer shared one temp filename, so one could rename
// another's half-written file into place.
const fresh = await mkdtemp(join(tmpdir(), "mun-concurrent-"));
await Promise.all(
  Array.from({ length: 40 }, (_, i) => store.saveSettings(fresh, withKey(`nvapi-concurrent-${i}`))),
);
const after = await readFile(join(fresh, "settings.json"), "utf8");
let parsed: any = null;
try { parsed = JSON.parse(after); } catch { /* left null */ }
check("40 concurrent saves leave valid JSON", parsed !== null, after.slice(0, 60));
check("40 concurrent saves leave a real key",
  /^nvapi-concurrent-\d+$/.test(parsed?.providers?.nvidia?.apiKey?.value ?? ""),
  parsed?.providers?.nvidia?.apiKey?.value ?? "(none)");

const leftovers = (await readdir(fresh)).filter((f) => f.endsWith(".tmp"));
check("no temp files left behind after concurrent writes", leftovers.length === 0, leftovers.join(", "));

// --- 6. Temp files are unique per write -------------------------------------
const names = new Set<string>();
for (let i = 0; i < 5; i += 1) {
  // Inspect during the write by racing a readdir against it.
  const p = store.saveSettings(fresh, withKey(`nvapi-unique-${i}`));
  const during = await readdir(fresh);
  for (const n of during) if (n.endsWith(".tmp")) names.add(n);
  await p;
}
check("temp filenames are not a fixed shared name", names.size !== 1 || names.size === 0,
  [...names].join(", ") || "(none observed)");

// --- 7. A failed write must not poison later writes -------------------------
let threw = false;
try {
  await store.saveSettings("/nonexistent\u0000path", withKey("nvapi-bad"));
} catch {
  threw = true;
}
check("an impossible write rejects", threw);
await store.saveSettings(fresh, withKey("nvapi-after-failure"));
const recovered = JSON.parse(await readFile(join(fresh, "settings.json"), "utf8"));
check("later writes still succeed after a failure",
  recovered.providers.nvidia.apiKey.value === "nvapi-after-failure",
  recovered.providers.nvidia.apiKey.value);

// --- 8. Nothing recoverable at all is still first run -----------------------
const empty = await mkdtemp(join(tmpdir(), "mun-empty-"));
const def = await store.loadSettings(empty);
check("a truly empty profile is still first run", Object.keys(def.providers).length === 0);

await rm(dir, { recursive: true, force: true }).catch(() => {});
await rm(fresh, { recursive: true, force: true }).catch(() => {});
await rm(empty, { recursive: true, force: true }).catch(() => {});

console.log(fail === 0 ? "\nAll durability checks passed." : `\n${fail} failed.`);
process.exitCode = fail === 0 ? 0 : 1;
