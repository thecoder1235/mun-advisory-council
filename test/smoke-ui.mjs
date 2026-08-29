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
 * Boots the real main-process wiring against a throwaway userData directory and
 * checks that a first-run user actually lands on a working setup screen.
 *
 * Run with: npm run smoke
 *
 * Note: no top-level await. Electron does not emit `ready` until the main
 * module has finished evaluating, so awaiting `app.whenReady()` at the top
 * level of an ESM main deadlocks with no output at all.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import electron from "electron";

const { app, dialog } = electron;

// Electron shows a modal dialog for an uncaught main-process exception, which
// in a headless run just hangs. Mirror output to a file and fail loudly.
const LOG = process.env.MUN_SMOKE_LOG ?? "smoke.log";
const log = (line) => {
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
if (dialog) {
  dialog.showErrorBox = (title, content) => appendFileSync(LOG, `DIALOG: ${title} ${content}\n`);
}

// A clean profile, so this tests first-run behaviour rather than whatever this
// machine happens to have saved. Dev .env keys are cleared for the same reason.
const profile = mkdtempSync(join(tmpdir(), "mun-smoke-"));
app.setPath("userData", profile);
delete process.env.NVIDIA_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

app.whenReady().then(async () => {
  const { bootstrap, entryPage } = await import("../dist/main/app.js");

  const win = await bootstrap();
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));

  check("first run routes to setup", entryPage() === "setup.html", entryPage());

  const url = win.webContents.getURL();
  check("setup.html is the loaded page", url.endsWith("setup.html"), url.split("/").pop());

  const api = await win.webContents.executeJavaScript(
    `({
       bridge: typeof window.mun,
       hasCheck: typeof window.mun?.settings?.checkKey,
       hasSave: typeof window.mun?.settings?.saveKey,
       canReadKeys: typeof window.mun?.settings?.getKey,
       title: document.querySelector("h1")?.textContent ?? "",
       button: document.querySelector("#save")?.disabled,
       note: document.querySelector("#note")?.textContent ?? "",
       link: document.querySelector("#link-nvidia")?.textContent ?? ""
     })`,
  );

  check("preload bridge is exposed", api.bridge === "object", api.bridge);
  check("renderer can request a key check", api.hasCheck === "function");
  check("renderer can save a key", api.hasSave === "function");
  check("renderer cannot read keys back", api.canReadKeys === "undefined");
  check("setup screen rendered", api.title.includes("Set up"), api.title);
  check("save disabled until a key is typed", api.button === true);
  check("links to build.nvidia.com", api.link.includes("build.nvidia.com"), api.link);

  const modelStep = await win.webContents.executeJavaScript(
    `({ hidden: document.querySelector("#model-step")?.hidden,
        hasInput: !!document.querySelector("#model"),
        hasVerify: typeof window.mun.models?.verify })`,
  );
  check("model fallback step exists but is hidden initially", modelStep.hidden === true && modelStep.hasInput === true);
  check("renderer can verify a single model", modelStep.hasVerify === "function");

  const noKeyVerify = await win.webContents.executeJavaScript(
    `window.mun.models.verify("nvidia", "some/model")`,
  );
  check("verifying a model without a key says so", noKeyVerify.ok === false && /save an api key/i.test(noKeyVerify.message), noKeyVerify.message);
  check("tells the user where the key is stored", api.note.includes(profile), api.note.slice(0, 70));

  // Saving verifies the key with a real one-token completion. NVIDIA's
  // /v1/models is unauthenticated — it answers with no key at all — so listing
  // models can never be the check.
  const saved = await win.webContents.executeJavaScript(
    `window.mun.settings.saveKey("nvidia", "nvapi-smoke-test-key")`,
  );
  check("invalid key is refused", saved.ok === false, saved.message);
  check(
    "rejection says the key was rejected, not a generic failure",
    /rejected/i.test(saved.message),
    saved.message,
  );
  check("invalid key is not stored", entryPage() === "setup.html", entryPage());

  const state = await win.webContents.executeJavaScript(`window.mun.settings.state()`);
  check("state never returns a key", !JSON.stringify(state).includes("nvapi-smoke-test-key"));
  check("encryption reported", typeof state.encryptionAvailable === "boolean", `encrypted: ${state.encryptionAvailable}`);

  // Model roles are persisted independently of any key.
  check("three model roles offered", state.roles.length === 3, state.roles.map((r) => r.id).join(", "));
  check("roles cover default, router, devils-advocate",
    ["default", "router", "devils-advocate"].every((id) => state.roles.some((r) => r.id === id)));
  check("roles start unset (inherit)", state.roles.every((r) => r.model === null));

  const roleSet = await win.webContents.executeJavaScript(
    `window.mun.settings.setRoleModel("devils-advocate", "some/unlisted-model")`,
  );
  check("free-text model is accepted", roleSet.ok === true);
  check(
    "role model persists",
    roleSet.state.roles.find((r) => r.id === "devils-advocate").model === "some/unlisted-model",
  );

  const cleared = await win.webContents.executeJavaScript(
    `window.mun.settings.setRoleModel("devils-advocate", "")`,
  );
  check("clearing a role returns it to inherit",
    cleared.state.roles.find((r) => r.id === "devils-advocate").model === null);

  const order = await win.webContents.executeJavaScript(
    `window.mun.settings.setProviderOrder(["nvidia", "openrouter"])`,
  );
  check("fallback order persists", order.state.providerOrder.join(",") === "nvidia,openrouter", order.state.providerOrder.join(","));

  const badOrder = await win.webContents.executeJavaScript(
    `window.mun.settings.setProviderOrder(["nvidia", "not-a-provider"])`,
  );
  check("unknown provider ids are dropped from order",
    badOrder.state.providerOrder.join(",") === "nvidia", badOrder.state.providerOrder.join(","));

  // Refresh must not throw with no usable key; it reports per provider.
  const refreshed = await win.webContents.executeJavaScript(`window.mun.models.refresh()`);
  check("refresh returns per-provider results", refreshed.ok === true && typeof refreshed.results === "object",
    Object.keys(refreshed.results ?? {}).join(", "));
  check("refresh reports no key set", refreshed.results.nvidia?.ok === false, refreshed.results.nvidia?.message);

  // Attach the listener before triggering navigation: did-finish-load can fire
  // before the invoke resolves, and a listener added afterwards waits forever.
  const loaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  const nav = await win.webContents.executeJavaScript(`window.mun.navigate("settings.html")`);
  check("can navigate to settings", nav.ok === true);
  await loaded;
  const settingsUi = await win.webContents.executeJavaScript(
    `({ roles: document.querySelectorAll("#roles .role").length,
        selects: document.querySelectorAll("#roles select").length,
        inputs: document.querySelectorAll("#roles input.escape").length,
        saveButtons: document.querySelectorAll("#roles .escape-row button").length,
        bannerShown: !document.querySelector("#model-banner").hidden,
        bannerText: document.querySelector("#model-banner").textContent,
        refresh: !!document.querySelector("#refresh"),
        fallback: !!document.querySelector("#fallback") })`,
  );
  check("settings renders a row per role", settingsUi.roles === 3, String(settingsUi.roles));
  check("each role has a model name input", settingsUi.inputs === 3, String(settingsUi.inputs));
  check("each role input has its own Save button", settingsUi.saveButtons === 3, String(settingsUi.saveButtons));
  // With no reachable catalog a dropdown would list nothing, so it is omitted
  // and the typed field carries the whole job.
  check("dropdown omitted when no catalog is reachable", settingsUi.selects === 0, String(settingsUi.selects));
  check("banner explains per-model keys", settingsUi.bannerShown === true && /each model's own page/i.test(settingsUi.bannerText));
  check("banner does not frame typing as a fallback", !/fallback|escape hatch|last resort/i.test(settingsUi.bannerText));
  check("refresh button present", settingsUi.refresh === true);
  check("fallback provider picker present", settingsUi.fallback === true);

  const diag = await win.webContents.executeJavaScript(
    `({ hasTest: typeof window.mun.diagnostics?.testConnection,
        hasLog: typeof window.mun.diagnostics?.log,
        btn: !!document.querySelector("#test-connection"),
        pre: !!document.querySelector("#log") })`,
  );
  check("connection test exposed to renderer", diag.hasTest === "function");
  check("request log exposed to renderer", diag.hasLog === "function");
  check("settings has a Test connection button", diag.btn === true);
  check("settings has a request details panel", diag.pre === true);

  const conn = await win.webContents.executeJavaScript(
    `window.mun.diagnostics.testConnection("nvidia")`,
  );
  check("connection test reaches NVIDIA", conn.ok === true, conn.message);
  check("connection test reports latency", typeof conn.elapsedMs === "number", `${conn.elapsedMs}ms`);
  check("connection test needs no key", conn.url.endsWith("/models"), conn.url);

  const logged = await win.webContents.executeJavaScript(`window.mun.diagnostics.log()`);
  check("request log records the URL and status", /integrate\.api\.nvidia\.com/.test(logged.text) && /HTTP 200/.test(logged.text));
  check("request log shows the timeout budget", /ms of \d+ms budget/.test(logged.text));

  const badNav = await win.webContents.executeJavaScript(`window.mun.navigate("../../etc/passwd")`);
  check("navigation is restricted to app screens", badNav.ok === false);

  const blocked = await win.webContents.executeJavaScript(
    `window.mun.openExternal("https://evil.example.com/")`,
  );
  check("external links are allow-listed", blocked.ok === false);

  // Best effort: Electron still holds handles inside the profile until exit,
  // and a leftover temp directory is not worth failing the run over.
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  log(failures === 0 ? "All smoke checks passed." : `${failures} check(s) failed.`);
  app.exit(failures === 0 ? 0 : 1);
});
