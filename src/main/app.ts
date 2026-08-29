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

import { join } from "node:path";

// Electron is a CommonJS module whose named exports Node's ESM loader cannot
// detect statically, so an ESM main must take the default export and
// destructure it rather than importing names directly.
import electron from "electron";

import { setAgentsDir } from "../agents/loader.ts";
import { listHistory, readAnswer, saveAnswer } from "../council/history.ts";
import { runCouncil, type CouncilEvent } from "../council/run.ts";
import { ALL_AGENTS, type AgentName } from "../council/router.ts";
import {
  checkApiKey,
  formatAttempts,
  PROVIDERS,
  providerById,
  testConnection,
  verifyModel,
} from "../providers/index.ts";
import {
  loadCatalog,
  refreshCatalog,
  saveCatalog,
  type ModelCatalog,
} from "../settings/model-catalog.ts";
import {
  loadSettings,
  modelForAgent,
  MODEL_ROLES,
  orderedProviders,
  resolveAllKeys,
  resolveProviderKey,
  roleModel,
  saveSettings,
  setProviderKey,
  setProviderOrder,
  setRoleModel,
  PLAINTEXT_CODEC,
  type SecretCodec,
} from "../settings/store.ts";
import { DEFAULT_SETTINGS, type Settings } from "../settings/types.ts";
import { ModelWarmer, type WarmthStatus } from "../providers/warmth.ts";
import { fetchCharacter, setCacheRoot } from "../wiki/index.ts";

/**
 * Main-process wiring: window, IPC, settings, key storage and the model
 * catalog.
 *
 * Kept separate from the entry point so a smoke test can boot the same code
 * path the app uses, rather than a re-implementation of it that could drift.
 */

const { app, BrowserWindow, ipcMain, safeStorage, shell } = electron;

let window: electron.BrowserWindow | null = null;
// Defaulted rather than left undefined: entryPage() is safe to call before
// bootstrap has loaded anything from disk.
let settings: Settings = DEFAULT_SETTINGS;
let codec: SecretCodec = PLAINTEXT_CODEC;
let catalog: ModelCatalog = {};
let warmer: ModelWarmer | null = null;

/**
 * The council run currently in flight, or the last one that finished.
 *
 * Navigation replaces the whole page, so a delegate who opens Settings during a
 * run loses every card, the progress display and the elapsed clock — while the
 * run itself carries on in this process. Without somewhere to rebuild from, the
 * screen comes back blank and the honest reading is "my answer was lost", which
 * costs another 8 minutes of re-asking. Events are kept so the returning page
 * can replay them into exactly the state it left.
 */
interface LiveRun {
  active: boolean;
  startedAt: number;
  question: string;
  characters: string[];
  events: CouncilEvent[];
  answer: unknown | null;
  error: string | null;
}
let liveRun: LiveRun | null = null;
/** Set when settings were restored from the backup copy on this launch. */
let recoveryNotice: string | null = null;

/**
 * Keys are encrypted with the OS keystore (DPAPI on Windows) where available,
 * so a settings file lifted off the machine is not a usable credential. Where
 * it is unavailable the key is stored in plaintext and the setup screen says
 * so — silently downgrading would be worse than telling the user.
 */
function buildCodec(): SecretCodec {
  if (!safeStorage.isEncryptionAvailable()) return PLAINTEXT_CODEC;
  return {
    scheme: "safeStorage-v1",
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret.value, "base64")),
  };
}

function userDataDir(): string {
  return app.getPath("userData");
}

function currentKeys(): Record<string, string> {
  return resolveAllKeys(settings, PROVIDERS, codec);
}

/** Whether any provider has a usable key, from settings or a dev .env. */
function configuredProviderIds(): string[] {
  return PROVIDERS.filter(
    (p) => resolveProviderKey(settings, p.id, p.keyEnv, codec) !== undefined,
  ).map((p) => p.id);
}

/**
 * Start provisioning the model before the delegate asks anything.
 *
 * The first call to a cold NVIDIA function pays 84-111s of GPU provisioning.
 * Doing it at launch, while they are still reading the setup or council screen,
 * moves that cost off the critical path of their first question.
 */
function startWarming(): void {
  const provider = providerById("nvidia");
  if (!provider) return;

  warmer?.stop();
  warmer = new ModelWarmer({
    provider,
    getKey: () => resolveProviderKey(settings, provider.id, provider.keyEnv, codec)?.key,
    getModel: () => modelForAgent(settings, "canon-keeper"),
    onChange: (status) => {
      if (window && !window.isDestroyed()) window.webContents.send("warmth", status);
    },
  });
  warmer.start();
}

function warmthStatus(): WarmthStatus {
  return (
    warmer?.status() ?? {
      state: "cold",
      model: null,
      lastLatencyMs: null,
      lastSuccessAt: null,
      message: "Not started.",
    }
  );
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: "#0d0d10",
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // An ESM preload is only loaded when the renderer is unsandboxed; with
      // the default sandbox it is silently ignored and window.mun never
      // appears. Context isolation still stands between the page and Node.
      sandbox: false,
    },
  });

  window.once("ready-to-show", () => window?.show());

  // Pings are for a window someone is looking at.
  window.on("hide", () => warmer?.setVisible(false));
  window.on("minimize", () => warmer?.setVisible(false));
  window.on("show", () => warmer?.setVisible(true));
  window.on("restore", () => warmer?.setVisible(true));
  window.on("focus", () => warmer?.noteActivity());

  void navigate(entryPage());
}

async function navigate(page: string): Promise<void> {
  // Resolved relative to this module, not app.getAppPath(): that returns the
  // directory of whatever script launched Electron, which differs between
  // `electron .`, a test harness, and the packaged app.
  await window?.loadFile(join(import.meta.dirname, "..", "renderer", page));
}

/** Which screen a fresh launch would show. Exported for the smoke test. */
export function entryPage(): "setup.html" | "council.html" {
  return configuredProviderIds().length > 0 ? "council.html" : "setup.html";
}

/** The payload every settings-aware screen renders from. */
function settingsState() {
  const providers = PROVIDERS.map((p) => {
    const resolved = resolveProviderKey(settings, p.id, p.keyEnv, codec);
    const entry = catalog[p.id];
    return {
      id: p.id,
      label: p.label,
      defaultModel: p.defaultModel,
      keyEnv: p.keyEnv,
      configured: resolved !== undefined,
      source: resolved?.source ?? null,
      models: entry?.models ?? [],
      modelsFetchedAt: entry?.fetchedAt ?? null,
    };
  });

  return {
    providers,
    roles: MODEL_ROLES.map((role) => ({
      ...role,
      // null means "inherit", which the screen shows rather than a fake value.
      model: roleModel(settings, role.id) ?? null,
    })),
    providerOrder: settings.providerOrder,
    configuredProviderIds: configuredProviderIds(),
    encryptionAvailable: codec.scheme !== "none",
    outputLanguage: settings.outputLanguage,
    settingsPath: join(userDataDir(), "settings.json"),
    recoveryNotice,
  };
}

function registerIpc(): void {
  ipcMain.handle("settings:state", () => settingsState());

  ipcMain.handle("settings:checkKey", async (_event, providerId: unknown, apiKey: unknown) => {
    const provider = providerById(String(providerId));
    if (!provider) return { ok: false, message: "Unknown provider.", models: [] };
    return checkApiKey(provider, String(apiKey));
  });

  /**
   * Saving a key, verifying it, and discovering what it can reach are one
   * action.
   *
   * A key that fails authentication is not stored. A key that authenticates but
   * whose models are all unavailable to the account *is* stored: the key is
   * fine, and refusing it would send the user off to regenerate something that
   * was never broken. The reply flags that case so the screen can ask for a
   * model id instead of blaming the key.
   */
  ipcMain.handle("settings:saveKey", async (_event, providerId: unknown, apiKey: unknown) => {
    const provider = providerById(String(providerId));
    if (!provider) return { ok: false, message: "Unknown provider.", models: [] };

    const result = await checkApiKey(provider, String(apiKey));
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        models: [],
        triedModels: result.triedModels ?? [],
      };
    }

    settings = setProviderKey(settings, provider.id, String(apiKey), codec);

    // Seed the default role only with a model that actually answered. Seeding
    // an unreachable id would just move the failure to the first question.
    if (settings.globalModel === undefined && result.suggestedModel !== undefined) {
      settings = setRoleModel(settings, "default", result.suggestedModel);
    }
    await saveSettings(userDataDir(), settings);

    catalog = {
      ...catalog,
      [provider.id]: { models: result.models ?? [], fetchedAt: new Date().toISOString() },
    };
    await saveCatalog(userDataDir(), catalog);

    // A new key usually means a new model; start provisioning it now.
    startWarming();

    return {
      ok: true,
      modelReachable: result.modelReachable === true,
      message: `Key saved. ${result.message}`,
      models: result.models ?? [],
      triedModels: result.triedModels ?? [],
      attempts: result.attempts ?? [],
      state: settingsState(),
    };
  });

  /**
   * Confirm one model id against the stored key. The user is the only one who
   * knows which model a scoped key was issued for, so their answer is checked
   * rather than trusted.
   */
  ipcMain.handle("models:verify", async (_event, providerId: unknown, model: unknown) => {
    const provider = providerById(String(providerId));
    if (!provider) return { ok: false, message: "Unknown provider." };

    const resolved = resolveProviderKey(settings, provider.id, provider.keyEnv, codec);
    if (!resolved) return { ok: false, message: "Save an API key first." };

    return verifyModel(provider, resolved.key, String(model));
  });

  ipcMain.handle("settings:clearKey", async (_event, providerId: unknown) => {
    const provider = providerById(String(providerId));
    if (!provider) return { ok: false, message: "Unknown provider." };
    settings = setProviderKey(settings, provider.id, "", codec);
    await saveSettings(userDataDir(), settings);
    return { ok: true, message: "Key removed.", state: settingsState() };
  });

  /** Re-fetch every configured provider's catalog, so new releases appear. */
  ipcMain.handle("models:refresh", async () => {
    const outcome = await refreshCatalog(userDataDir(), PROVIDERS, currentKeys(), catalog);
    catalog = outcome.catalog;
    return { ok: true, results: outcome.results, state: settingsState() };
  });

  ipcMain.handle("settings:setRoleModel", async (_event, role: unknown, model: unknown) => {
    settings = setRoleModel(settings, String(role), String(model));
    await saveSettings(userDataDir(), settings);
    // The default model drives warm-up, so a change restarts provisioning.
    if (String(role) === "default") startWarming();
    return { ok: true, state: settingsState() };
  });

  ipcMain.handle("settings:setProviderOrder", async (_event, order: unknown) => {
    const ids = Array.isArray(order) ? order.map(String).filter((id) => providerById(id)) : [];
    settings = setProviderOrder(settings, ids);
    await saveSettings(userDataDir(), settings);
    return { ok: true, state: settingsState() };
  });

  /**
   * Plain reachability check: no key, no model, no interpretation. It answers
   * only "can this machine talk to the provider", which is the one question the
   * key and model checks cannot answer for you.
   */
  ipcMain.handle("diagnostics:testConnection", async (_event, providerId: unknown) => {
    const provider = providerById(String(providerId ?? "nvidia"));
    if (!provider) return { ok: false, message: "Unknown provider." };
    return testConnection(provider);
  });

  /** The raw request log, so the user can see exactly what was sent and what came back. */
  ipcMain.handle("diagnostics:log", () => ({ text: formatAttempts() }));

  // -------------------------------------------------------------------------
  // The council
  // -------------------------------------------------------------------------

  /** Load a character and return the per-wiki outcome, gaps included. */
  ipcMain.handle("council:addCharacter", async (_event, name: unknown, overrides: unknown) => {
    const query = String(name ?? "").trim();
    if (query === "") return { ok: false, message: "Enter a character name." };

    const dossier = await fetchCharacter(query, {
      ...(overrides && typeof overrides === "object"
        ? { titleOverrides: overrides as Record<string, string> }
        : {}),
    });

    return {
      ok: true,
      dossier: {
        query: dossier.query,
        results: dossier.results.map((r) =>
          r.status === "found"
            ? {
                status: "found" as const,
                wikiId: r.wiki.id,
                wiki: r.wiki.label,
                canon: r.page.canon,
                title: r.page.resolvedTitle,
                url: r.page.url,
                chars: r.page.extract.length,
                fromCache: r.fromCache,
                // Pages cached before this field existed have no alternatives;
                // default rather than handing the renderer undefined.
                alternatives: r.page.resolution.alternatives ?? [],
              }
            : r.status === "missing"
              ? {
                  status: "missing" as const,
                  wikiId: r.wiki.id,
                  wiki: r.wiki.label,
                  canon: r.wiki.canon,
                  reason: r.reason,
                  detail: r.detail,
                  candidates: r.candidates.slice(0, 5),
                }
              : {
                  status: "error" as const,
                  wikiId: r.wiki.id,
                  wiki: r.wiki.label,
                  canon: r.wiki.canon,
                  error: r.error,
                },
        ),
      },
    };
  });

  ipcMain.handle("council:agents", () => ALL_AGENTS);

  /**
   * Ask the council. Streams progress to the renderer as each agent settles so
   * cards appear as they arrive rather than after the slowest one.
   */
  ipcMain.handle(
    "council:ask",
    async (event, question: unknown, characters: unknown, forceAgents: unknown) => {
      const text = String(question ?? "").trim();
      if (text === "") return { ok: false, message: "Ask a question first." };

      const names = Array.isArray(characters) ? characters.map(String) : [];
      const keys = currentKeys();
      const chain = orderedProviders(settings, PROVIDERS, keys);

      if (chain.length === 0) {
        return { ok: false, message: "No API key configured. Open Settings." };
      }

      warmer?.noteActivity();

      const dossiers = [];
      for (const name of names) {
        dossiers.push(await fetchCharacter(name));
      }

      const models: Record<string, string | undefined> = { router: modelForAgent(settings, "router") };
      for (const agent of ALL_AGENTS) models[agent] = modelForAgent(settings, agent);

      liveRun = {
        active: true,
        startedAt: Date.now(),
        question: text,
        characters: names,
        events: [],
        answer: null,
        error: null,
      };

      const send = (payload: CouncilEvent): void => {
        liveRun?.events.push(payload);
        if (!event.sender.isDestroyed()) event.sender.send("council:event", payload);
      };

      // Terminal outcomes go down the event channel too, not just the invoke
      // reply: a page that navigated away no longer holds that promise, and
      // would otherwise never learn the run finished.
      const finish = (payload: unknown): void => {
        if (!event.sender.isDestroyed()) event.sender.send("council:event", payload);
      };

      try {
        const answer = await runCouncil({
          question: text,
          dossiers,
          apiKeys: keys,
          providers: chain,
          models,
          outputLanguage: settings.outputLanguage,
          ...(Array.isArray(forceAgents)
            ? { forceAgents: forceAgents.map(String).filter((a): a is AgentName => (ALL_AGENTS as readonly string[]).includes(a)) }
            : {}),
          onEvent: send,
        });

        const entry = await saveAnswer(userDataDir(), answer);
        if (liveRun) {
          liveRun.active = false;
          liveRun.answer = entry;
        }
        finish({ type: "done", answer: entry });
        return { ok: true, answer: entry };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (liveRun) {
          liveRun.active = false;
          liveRun.error = message;
        }
        finish({ type: "failed", message });
        return { ok: false, message };
      }
    },
  );

  /** The in-flight or most recent run, so a returning page can rebuild itself. */
  ipcMain.handle("council:liveRun", () => liveRun);

  ipcMain.handle("council:history", () => listHistory(userDataDir()));

  ipcMain.handle("council:answer", async (_event, id: unknown) => {
    const entry = await readAnswer(userDataDir(), String(id ?? ""));
    return entry === undefined ? { ok: false } : { ok: true, answer: entry };
  });

  /** The user guide, answered from disk for `help` routing outcomes. */
  ipcMain.handle("council:guide", async () => {
    try {
      const { loadPrompt } = await import("../agents/loader.ts");
      return { ok: true, text: await loadPrompt("user-guide") };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("warmth:status", () => warmthStatus());
  ipcMain.handle("warmth:warm", async () => {
    if (warmer === null) startWarming();
    return (await warmer?.warmNow()) ?? warmthStatus();
  });

  ipcMain.handle("navigate", async (_event, page: unknown) => {
    const target = String(page);
    // Only the app's own screens; never an arbitrary path from the renderer.
    if (!["setup.html", "settings.html", "council.html"].includes(target)) {
      return { ok: false };
    }
    // Reply before navigating. Awaiting the load would hold the reply until the
    // calling frame has already been torn down, and the renderer's promise
    // would never settle.
    void navigate(target);
    return { ok: true };
  });

  ipcMain.handle("settings:continue", async () => {
    void navigate(entryPage());
    return { ok: true };
  });

  // Only the handful of URLs the setup screen needs, so a compromised renderer
  // cannot use this to launch arbitrary things.
  const ALLOWED_LINKS = new Set([
    "https://build.nvidia.com/",
    "https://aistudio.google.com/apikey",
    "https://openrouter.ai/keys",
  ]);
  ipcMain.handle("shell:openExternal", async (_event, url: unknown) => {
    const target = String(url);
    if (!ALLOWED_LINKS.has(target)) return { ok: false };
    await shell.openExternal(target);
    return { ok: true };
  });
}

/**
 * Boot the app: load settings and the cached model catalog, register IPC, open
 * the window on whichever screen the current configuration calls for.
 */
export async function bootstrap(): Promise<electron.BrowserWindow> {
  codec = buildCodec();
  settings = await loadSettings(userDataDir(), {
    onRecover: (detail) => {
      // Surfaced rather than silent: a delegate whose key came back from the
      // backup should know it happened, not just find things working.
      recoveryNotice = detail;
      console.warn(`[settings] ${detail}`);
    },
  });
  catalog = await loadCatalog(userDataDir());

  // In dev the cache and prompts live beside the source so they are easy to
  // inspect; once packaged, the install directory is read-only, so the cache
  // moves to userData and the prompts are read from the unpacked resources.
  if (app.isPackaged) {
    setCacheRoot(join(userDataDir(), "cache"));
    setAgentsDir(join(process.resourcesPath, "agents"));
  }

  registerIpc();
  createWindow();

  // Fire the first warm-up immediately: the sooner provisioning starts, the
  // more of it is absorbed by the delegate reading the screen.
  startWarming();

  // Refresh in the background rather than blocking the window: the cached
  // catalog is good enough to render with, and a slow or absent network must
  // never delay the app opening.
  void refreshCatalogInBackground();

  return window!;
}

async function refreshCatalogInBackground(): Promise<void> {
  if (configuredProviderIds().length === 0) return;
  try {
    const outcome = await refreshCatalog(userDataDir(), PROVIDERS, currentKeys(), catalog);
    catalog = outcome.catalog;
    if (window && !window.isDestroyed()) {
      window.webContents.send("models:updated", settingsState());
    }
  } catch {
    // A failed startup refresh is not worth surfacing; the cached list stands
    // and the settings screen has an explicit Refresh button.
  }
}
