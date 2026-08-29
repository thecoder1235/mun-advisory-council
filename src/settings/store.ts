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

import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  DEFAULT_SETTINGS,
  type ProviderSettings,
  type Settings,
  type StoredSecret,
} from "./types.ts";

/**
 * Reading and writing settings, and resolving which API key to actually use.
 *
 * Key resolution order is user settings first, then the environment. That way
 * the packaged app works for someone who has only ever seen the exe, while a
 * dev machine with a .env keeps working without a stored key.
 */

/**
 * How secrets are encoded at rest. Electron supplies an OS-backed codec
 * (DPAPI on Windows); outside Electron there is nothing to back it, so the
 * plaintext codec is used and says so rather than pretending otherwise.
 */
export interface SecretCodec {
  readonly scheme: string;
  encrypt(value: string): string;
  decrypt(secret: StoredSecret): string | null;
}

export const PLAINTEXT_CODEC: SecretCodec = {
  scheme: "none",
  encrypt: (value) => value,
  decrypt: (secret) => (secret.scheme === "none" ? secret.value : null),
};

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}

function coerce(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const obj = raw as Partial<Settings>;
  return {
    version: 1,
    providers: obj.providers ?? {},
    providerOrder: obj.providerOrder ?? [],
    agentModels: obj.agentModels ?? {},
    outputLanguage: obj.outputLanguage ?? DEFAULT_SETTINGS.outputLanguage,
    ...(obj.globalModel === undefined ? {} : { globalModel: obj.globalModel }),
  };
}

/** The rolling copy of the last settings file known to parse. */
export function backupPath(userDataDir: string): string {
  return join(userDataDir, "settings.backup.json");
}

async function readSettingsFile(path: string): Promise<Settings | null> {
  try {
    const raw = await readFile(path, "utf8");
    // A zero-length file is the signature of an interrupted write, and must be
    // treated as absent rather than as "no settings".
    if (raw.trim() === "") return null;
    return coerce(JSON.parse(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || err instanceof SyntaxError) return null;
    throw err;
  }
}

export interface LoadOptions {
  /** Called when the primary file was unusable and the backup was restored. */
  readonly onRecover?: (detail: string) => void;
}

/**
 * Read settings, falling back to the backup copy.
 *
 * Losing this file means losing the API key, and the failure is silent: the app
 * simply shows first-run setup again, which reads as "the app forgot" with no
 * explanation. So a missing or unparseable primary is not treated as first run
 * until the backup has also been ruled out.
 */
export async function loadSettings(
  userDataDir: string,
  opts: LoadOptions = {},
): Promise<Settings> {
  const primary = settingsPath(userDataDir);
  const fromPrimary = await readSettingsFile(primary);
  if (fromPrimary !== null) return fromPrimary;

  const backup = backupPath(userDataDir);
  const fromBackup = await readSettingsFile(backup);
  if (fromBackup === null) return DEFAULT_SETTINGS;

  // Put the recovered copy back so the next save has a base, and so a second
  // failure does not exhaust the only remaining copy.
  try {
    await copyFile(backup, primary);
  } catch {
    /* recovery is still valid in memory even if the copy back fails */
  }
  opts.onRecover?.(`settings.json was missing or unreadable; recovered from ${backup}`);
  return fromBackup;
}

/**
 * Saves are serialised process-wide.
 *
 * Four IPC handlers can write settings, and the renderer can trigger them in
 * overlapping order (saving a key immediately restarts warm-up, which can save
 * a model). Two concurrent writes previously shared one fixed temp filename, so
 * one could truncate the other's temp file and the survivor would rename a
 * half-written document into place. A parse failure then reads as "no key
 * configured", which is indistinguishable from a fresh install.
 */
let writeChain: Promise<unknown> = Promise.resolve();

async function writeSettingsNow(userDataDir: string, settings: Settings): Promise<void> {
  const path = settingsPath(userDataDir);
  await mkdir(dirname(path), { recursive: true });

  // Unique per write, so concurrent or crashed writers can never share one.
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const body = `${JSON.stringify(settings, null, 2)}\n`;

  const handle = await open(temp, "w");
  try {
    await handle.writeFile(body, "utf8");
    // Force the bytes to disk before the rename. Without this the rename can
    // land while the contents have not, leaving a zero-length settings file.
    await handle.sync();
  } finally {
    await handle.close();
  }

  // Keep the previous good copy before replacing it. This is the difference
  // between "re-enter your key" and "the app recovered by itself".
  try {
    await copyFile(path, backupPath(userDataDir));
  } catch (err) {
    // Nothing to back up on first write.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await rename(temp, path);
  await cleanStaleTemps(userDataDir, temp);
}

/** Remove temp files left by a crashed or force-killed write. */
async function cleanStaleTemps(userDataDir: string, current: string): Promise<void> {
  try {
    for (const name of await readdir(userDataDir)) {
      if (!name.startsWith("settings.json.") || !name.endsWith(".tmp")) continue;
      const full = join(userDataDir, name);
      if (full === current) continue;
      await unlink(full).catch(() => {});
    }
  } catch {
    /* tidying is best effort and must never fail a save */
  }
}

export async function saveSettings(userDataDir: string, settings: Settings): Promise<void> {
  const run = (): Promise<void> => writeSettingsNow(userDataDir, settings);
  const result = writeChain.then(run, run);
  // The chain must survive a failed write, or every later save is rejected.
  writeChain = result.catch(() => undefined);
  return result;
}

export function setProviderKey(
  settings: Settings,
  providerId: string,
  apiKey: string,
  codec: SecretCodec,
): Settings {
  const existing = settings.providers[providerId] ?? {};
  const trimmed = apiKey.trim();

  // An empty key clears the stored one rather than saving a blank. The property
  // is dropped rather than set to undefined so the written JSON has no dead key.
  const { apiKey: _dropped, ...rest } = existing;
  const provider: ProviderSettings =
    trimmed === ""
      ? rest
      : { ...rest, apiKey: { scheme: codec.scheme, value: codec.encrypt(trimmed) } };

  return {
    ...settings,
    providers: { ...settings.providers, [providerId]: provider },
  };
}

export function setProviderModel(
  settings: Settings,
  providerId: string,
  model: string,
): Settings {
  const existing = settings.providers[providerId] ?? {};
  const trimmed = model.trim();
  const { model: _dropped, ...rest } = existing;
  const provider: ProviderSettings = trimmed === "" ? rest : { ...rest, model: trimmed };
  return {
    ...settings,
    providers: { ...settings.providers, [providerId]: provider },
  };
}

export interface ResolvedKey {
  readonly key: string;
  /** Where it came from, so the UI can say "using your saved key" vs a dev .env. */
  readonly source: "settings" | "env";
}

/**
 * User settings win over the environment. A key typed into the app is a
 * deliberate act by the person using it; a .env is a leftover of the machine it
 * happens to be running on.
 */
export function resolveProviderKey(
  settings: Settings,
  providerId: string,
  keyEnv: string,
  codec: SecretCodec,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKey | undefined {
  const stored = settings.providers[providerId]?.apiKey;
  if (stored) {
    const decrypted = decryptSecret(stored, codec);
    if (decrypted !== null && decrypted.trim() !== "") {
      return { key: decrypted.trim(), source: "settings" };
    }
  }

  const fromEnv = (env[keyEnv] ?? "").trim();
  if (fromEnv !== "") return { key: fromEnv, source: "env" };

  return undefined;
}

/**
 * A secret written by a codec that is not available now — a settings file
 * copied between machines, or OS encryption that has become unavailable —
 * cannot be recovered. Returning null makes the app ask for the key again
 * instead of sending ciphertext to a provider as if it were a key.
 */
export function decryptSecret(secret: StoredSecret, codec: SecretCodec): string | null {
  if (secret.scheme === "none") return secret.value;
  if (secret.scheme !== codec.scheme) return null;
  try {
    return codec.decrypt(secret);
  } catch {
    return null;
  }
}

/** Build the provider id -> key map the provider layer expects. */
export function resolveAllKeys(
  settings: Settings,
  providers: readonly { id: string; keyEnv: string }[],
  codec: SecretCodec,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const provider of providers) {
    const resolved = resolveProviderKey(settings, provider.id, provider.keyEnv, codec, env);
    if (resolved) keys[provider.id] = resolved.key;
  }
  return keys;
}

/**
 * Where Electron would put userData for this app, computed without importing
 * Electron so the CLI can read the same settings file the app writes.
 *
 * Must match `build.productName` in package.json — Electron derives the folder
 * name from it.
 */
function userDataDirFor(appName: string): string {
  const { APPDATA, HOME, XDG_CONFIG_HOME } = process.env;
  if (process.platform === "win32" && APPDATA) return join(APPDATA, appName);
  if (process.platform === "darwin" && HOME) {
    return join(HOME, "Library", "Application Support", appName);
  }
  if (XDG_CONFIG_HOME) return join(XDG_CONFIG_HOME, appName);
  return join(HOME ?? ".", ".config", appName);
}

/**
 * Where Electron put userData for this app, computed without importing Electron
 * so the CLI can read the same settings file the app writes.
 *
 * Two names are possible, and which one applies depends on how the app was
 * launched rather than on anything in this file. Electron derives userData from
 * the app name: in development that is package.json `name`, while a packaged
 * build uses electron-builder's `productName`. Guessing one silently reads an
 * empty profile and reports "no key stored" for a key that is sitting on disk
 * under the other name, so both are checked and whichever actually holds
 * settings wins.
 */
export function defaultUserDataDir(): string {
  const candidates = ["mun-advisory-council", "MUN Advisory Council"].map(userDataDirFor);
  return candidates.find((dir) => existsSync(join(dir, "settings.json"))) ?? candidates[0]!;
}

/** Every profile directory this app might have written to, for diagnostics. */
export function userDataCandidates(): string[] {
  return ["mun-advisory-council", "MUN Advisory Council"].map(userDataDirFor);
}

/**
 * The roles a model can be chosen for.
 *
 * Not every agent gets its own picker. The router runs on every question and is
 * a cheap classification job, so it pays to run it on something small; the
 * devil's advocate is the one agent whose whole value is arguing well, so it
 * pays to run it on something strong. Everything else follows the default.
 */
export const MODEL_ROLES = [
  {
    id: "default",
    label: "Default model",
    hint: "Used by every agent that has no override.",
  },
  {
    id: "router",
    label: "Router",
    hint: "Runs on every question to decide which agents wake. A small, fast model is usually enough.",
  },
  {
    id: "devils-advocate",
    label: "Devil's advocate",
    hint: "Attacks the delegate's plan. Worth the strongest model available.",
  },
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number]["id"];

/** The model chosen for a role, or undefined to inherit. */
export function roleModel(settings: Settings, role: string): string | undefined {
  return role === "default" ? settings.globalModel : settings.agentModels[role];
}

export function setRoleModel(settings: Settings, role: string, model: string): Settings {
  const trimmed = model.trim();

  if (role === "default") {
    const { globalModel: _dropped, ...rest } = settings;
    return trimmed === "" ? rest : { ...rest, globalModel: trimmed };
  }

  const { [role]: _removed, ...others } = settings.agentModels;
  return {
    ...settings,
    agentModels: trimmed === "" ? others : { ...others, [role]: trimmed },
  };
}

/**
 * Which model an agent should run on: its own override, else the default, else
 * nothing — in which case the provider's built-in default applies.
 */
export function modelForAgent(settings: Settings, agent: string): string | undefined {
  return settings.agentModels[agent] ?? settings.globalModel;
}

export function setProviderOrder(settings: Settings, order: readonly string[]): Settings {
  return { ...settings, providerOrder: [...order] };
}

/**
 * The provider chain to try, in order, restricted to those with a usable key.
 *
 * Providers the user has ordered come first; any other configured provider is
 * appended rather than dropped, so adding a key is enough to make it a
 * last-resort fallback without also having to arrange the order.
 */
export function orderedProviders<T extends { id: string }>(
  settings: Settings,
  providers: readonly T[],
  apiKeys: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv = process.env,
  keyEnvOf: (provider: T) => string = (p) => (p as unknown as { keyEnv: string }).keyEnv,
): T[] {
  const usable = providers.filter(
    (p) => (apiKeys[p.id] ?? "").trim() !== "" || (env[keyEnvOf(p)] ?? "").trim() !== "",
  );
  const ranked = settings.providerOrder
    .flatMap((id) => usable.filter((p) => p.id === id))
    .filter((p, i, all) => all.indexOf(p) === i);
  return [...ranked, ...usable.filter((p) => !ranked.includes(p))];
}
