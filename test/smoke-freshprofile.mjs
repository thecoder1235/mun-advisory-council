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
 * A completely empty userData directory — no settings.json, no catalog, no
 * history, no cache. Confirms the app reaches a working setup screen with
 * zero pre-existing config, exactly what a first-time user's machine looks
 * like.
 */
import { mkdtempSync, rmSync, existsSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";

const { app } = electron;
const profile = mkdtempSync(join(tmpdir(), "mun-fresh-"));
app.setPath("userData", profile);
delete process.env.NVIDIA_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const LOG = "smoke-fresh.log";
writeFileSync(LOG, "");
const log = (l) => { appendFileSync(LOG, `${l}\n`); console.log(l); };
process.on("uncaughtException", e => { appendFileSync(LOG, `UNCAUGHT: ${e?.stack ?? e}\n`); app.exit(1); });
process.on("unhandledRejection", e => { appendFileSync(LOG, `REJECTED: ${e?.stack ?? e}\n`); app.exit(1); });

let failures = 0;
const check = (n, ok, d="") => { if(!ok) failures++; log(`${ok?"PASS":"FAIL"}  ${n}${d?"  — "+d:""}`); };

app.whenReady().then(async () => {
  log(`profile: ${profile}`);
  check("profile directory starts completely empty", readdirSync(profile).length === 0);

  const { bootstrap, entryPage } = await import("../dist/main/app.js");
  check("no config -> routes to setup", entryPage() === "setup.html");

  const win = await bootstrap();
  await new Promise(r => win.webContents.once("did-finish-load", r));

  const url = win.webContents.getURL();
  check("setup screen actually loads with empty profile", url.endsWith("setup.html"), url);

  const ui = await win.webContents.executeJavaScript(`
    ({ hasWarning: /NVIDIA issues keys per model/i.test(document.body.textContent),
       hasKeyField: !!document.querySelector("#key"),
       hasNvidiaLink: !!document.querySelector("#link-nvidia"),
       title: document.querySelector("h1")?.textContent ?? "" })
  `);
  check("per-model-key warning shown upfront", ui.hasWarning === true);

  // The walkthrough is the only guidance a first-time user gets.
  const walk = await win.webContents.executeJavaScript(`
    ({ steps: document.querySelectorAll("ol.walk > li").length,
       body: document.body.textContent,
       modelIds: [...document.querySelectorAll("code.model-id")].map(n => n.textContent.trim()),
       howto: document.querySelectorAll("dl.howto dt").length })`);
  check("walkthrough has five ordered steps", walk.steps === 5, String(walk.steps));
  check("mentions the free account and phone verification", /phone verification/i.test(walk.body));
  check("names the exact model twice (key page and model field)",
    walk.modelIds.filter(m => m === "deepseek-ai/deepseek-v4-pro-0813").length >= 2, walk.modelIds.join(" | "));
  check("warns a profile-section key will not work", /profile section will/i.test(walk.body) || /account.*or profile section/i.test(walk.body));
  check("how-to section present", walk.howto >= 6, String(walk.howto));
  check("how-to covers load-your-character-first", /Add your own character first/i.test(walk.body));
  check("how-to states the 3-9 minute cost", /3[–-]9 minutes/.test(walk.body));
  check("how-to explains cards stream", /Cards appear as each agent finishes/i.test(walk.body));
  check("how-to explains UNVERIFIED", /not in the source/i.test(walk.body) && /survive a challenge/i.test(walk.body));
  check("how-to explains canon conflict value", /separate continuities/i.test(walk.body) && /contest/i.test(walk.body));
  check("how-to names the best question", /where does it break/i.test(walk.body));
  check("key input present", ui.hasKeyField === true);
  check("nvidia link present", ui.hasNvidiaLink === true);
  check("page renders a title", ui.title.length > 0, ui.title);

  // Confirm nothing was written to disk just by opening the screen.
  check("no settings.json written just by viewing setup", !existsSync(join(profile, "settings.json")));

  // The whole flow, driven exactly as a user would: type a bogus key, expect
  // rejection, with STILL no config file written (bad keys must not persist).
  const rejected = await win.webContents.executeJavaScript(
    `window.mun.settings.saveKey("nvidia", "nvapi-obviously-fake")`);
  check("bogus key rejected on a totally fresh profile", rejected.ok === false);
  check("rejected key still writes no config file", !existsSync(join(profile, "settings.json")));

  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  log(failures === 0 ? "All fresh-profile checks passed." : `${failures} failed.`);
  app.exit(failures === 0 ? 0 : 1);
});
