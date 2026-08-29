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
 * Checks the council screen renders and its IPC surface is present, against a
 * throwaway profile. Does not call a model.
 */
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";

const { app } = electron;
const profile = mkdtempSync(join(tmpdir(), "mun-council-"));
app.setPath("userData", profile);
delete process.env.NVIDIA_API_KEY;

const LOG = "smoke-council.log";
writeFileSync(LOG, "");
const log = (l) => { appendFileSync(LOG, `${l}\n`); console.log(l); };
process.on("uncaughtException", (e) => { appendFileSync(LOG, `UNCAUGHT: ${e?.stack ?? e}\n`); app.exit(1); });
process.on("unhandledRejection", (e) => { appendFileSync(LOG, `REJECTED: ${e?.stack ?? e}\n`); app.exit(1); });

let failures = 0;
const check = (n, ok, d = "") => { if (!ok) failures += 1; log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

app.whenReady().then(async () => {
  const { bootstrap } = await import("../dist/main/app.js");
  const win = await bootstrap();
  await new Promise((r) => win.webContents.once("did-finish-load", r));

  const loaded = new Promise((r) => win.webContents.once("did-finish-load", r));
  await win.webContents.executeJavaScript(`window.mun.navigate("council.html")`);
  await loaded;
  await new Promise((r) => setTimeout(r, 600));

  const ui = await win.webContents.executeJavaScript(`
    ({ title: document.querySelector("h1")?.textContent ?? "",
       hasCharPanel: !!document.querySelector("#chars"),
       hasQuestion: !!document.querySelector("#question"),
       hasAsk: !!document.querySelector("#ask"),
       hasHeadline: !!document.querySelector("#headline"),
       hasCards: !!document.querySelector("#cards"),
       examples: document.querySelectorAll("#examples button").length,
       api: typeof window.mun.council?.ask,
       addApi: typeof window.mun.council?.addCharacter,
       histApi: typeof window.mun.council?.history,
       evApi: typeof window.mun.council?.onEvent })
  `);

  check("council screen loads", ui.title.includes("MUN Advisory Council"), ui.title);
  check("character panel present", ui.hasCharPanel === true);
  check("question box present", ui.hasQuestion === true);
  check("ask button present", ui.hasAsk === true);
  check("headline slot present", ui.hasHeadline === true);
  check("agent card grid present", ui.hasCards === true);
  check("example questions shown on first run", ui.examples >= 3, String(ui.examples));
  check("council.ask exposed", ui.api === "function");
  check("council.addCharacter exposed", ui.addApi === "function");
  check("council.history exposed", ui.histApi === "function");
  check("council streaming events exposed", ui.evApi === "function");

  const agents = await win.webContents.executeJavaScript(`window.mun.council.agents()`);
  check("six agents registered", agents.length === 6, agents.join(", "));
  check("devils-advocate and coordinator present",
    agents.includes("devils-advocate") && agents.includes("coordinator"));

  const noKey = await win.webContents.executeJavaScript(
    `window.mun.council.ask("test", [], [])`);
  check("asking without a key is refused clearly", noKey.ok === false && /api key/i.test(noKey.message), noKey.message);

  const hist = await win.webContents.executeJavaScript(`window.mun.council.history()`);
  check("history starts empty", Array.isArray(hist) && hist.length === 0);

  const bad = await win.webContents.executeJavaScript(
    `window.mun.council.answer("../../../etc/passwd")`);
  check("history ids are validated", bad.ok === false);

  const guide = await win.webContents.executeJavaScript(`window.mun.council.guide()`);
  check("user guide loads from disk", guide.ok === true && guide.text.length > 100);

  const fetched = await win.webContents.executeJavaScript(
    `window.mun.council.addCharacter("Doctor Doom")`);
  check("character fetch works from the UI", fetched.ok === true);
  const found = (fetched.dossier?.results ?? []).filter((r) => r.status === "found");
  check("fetch returns per-wiki results", (fetched.dossier?.results ?? []).length === 4,
    `${found.length} found of ${(fetched.dossier?.results ?? []).length}`);
  check("found results carry canon and alternatives",
    found.every((r) => r.canon && Array.isArray(r.alternatives)));

  log(failures === 0 ? "All council smoke checks passed." : `${failures} failed.`);
  app.exit(failures === 0 ? 0 : 1);
});
