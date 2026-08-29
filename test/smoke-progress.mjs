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
 * Drives the council screen's event handler with a synthetic run and checks the
 * stage display and card streaming, without spending a single model call.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";

const { app } = electron;
const profile = mkdtempSync(join(tmpdir(), "mun-prog-"));
app.setPath("userData", profile);
delete process.env.NVIDIA_API_KEY;

const LOG = "smoke-progress.log";
writeFileSync(LOG, "");
const log = (l) => { appendFileSync(LOG, `${l}\n`); console.log(l); };
process.on("uncaughtException", e => { appendFileSync(LOG, `UNCAUGHT: ${e?.stack ?? e}\n`); app.exit(1); });
process.on("unhandledRejection", e => { appendFileSync(LOG, `REJECTED: ${e?.stack ?? e}\n`); app.exit(1); });

let failures = 0;
const check = (n, ok, d = "") => { if (!ok) failures += 1; log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

app.whenReady().then(async () => {
  const { bootstrap } = await import("../dist/main/app.js");
  const win = await bootstrap();
  await new Promise(r => win.webContents.once("did-finish-load", r));
  const loaded = new Promise(r => win.webContents.once("did-finish-load", r));
  await win.webContents.executeJavaScript(`window.mun.navigate("council.html")`);
  await loaded;
  await new Promise(r => setTimeout(r, 700));

  // First run: the long timing note must be visible before any question.
  const note = await win.webContents.executeJavaScript(
    `({ cls: document.querySelector("#timing-note").className,
        text: document.querySelector("#timing-note").textContent })`);
  check("first-run timing note is shown", note.cls.includes("first-run"), note.cls);
  check("timing note states 8-9 minutes", /8[–-]9 minutes/.test(note.text));
  check("timing note explains why", /GPU|cold start|two minutes/i.test(note.text));
  check("timing note says cards stream", /as soon as that agent finishes|as each agent finishes/i.test(note.text));

  // Simulate a run by driving the real event handler directly.
  const fire = (payload) => win.webContents.executeJavaScript(
    `(() => { require === undefined; return true; })()`).catch(() => true);

  // The handler is registered via preload's onEvent; emit through the same
  // channel the main process uses so this exercises the real path.
  const sendEvent = (payload) => {
    win.webContents.send("council:event", payload);
    return new Promise(r => setTimeout(r, 120));
  };

  await win.webContents.executeJavaScript(`resetProgress(); true`);
  await sendEvent({ type: "router", decision: {
    outcome: "proceed",
    agents: [{ name: "canon-keeper", focus: null }, { name: "devils-advocate", focus: null }, { name: "coordinator", focus: null }],
    rawAgents: [], corrections: [], reply: null } });

  let p = await win.webContents.executeJavaScript(
    `({ hidden: document.querySelector("#progress").hidden,
        rows: document.querySelectorAll("#progress .stage").length,
        text: document.querySelector("#progress").textContent })`);
  check("progress panel visible during a run", p.hidden === false);
  check("three stages shown", p.rows === 3, String(p.rows));
  check("router stage marked done after routing", /1\. Router/.test(p.text) && /decided which agents wake/.test(p.text));
  check("agent count from router shown", /2\. Agents \(2\)/.test(p.text), p.text.slice(0,120));

  await sendEvent({ type: "agent-start", agent: "canon-keeper", focus: null });
  await sendEvent({ type: "agent-start", agent: "devils-advocate", focus: null });
  p = await win.webContents.executeJavaScript(
    `({ text: document.querySelector("#progress").textContent,
        cards: document.querySelectorAll("#cards .card").length,
        cardsHidden: document.querySelector("#cards-section").hidden })`);
  check("cards appear as agents start", p.cards === 2, String(p.cards));
  check("card section revealed immediately", p.cardsHidden === false);
  check("in-flight agents named", /canon-keeper/.test(p.text) && /devils-advocate/.test(p.text));

  // One agent returns: its card must fill while the other is still running.
  await sendEvent({ type: "agent-done", result: {
    agent: "canon-keeper", focus: null, elapsedMs: 90000, model: "m", provider: "nvidia",
    text: "**Finding**\n\nDoom relies on his armour. [COMICS]\n\n**Where this breaks**\n\nThe armour claim is inferred.\n\n**Recommendation**\n\nPress on ego.\n\n**If I'm wrong**\n\nSource may be stale." } });

  p = await win.webContents.executeJavaScript(
    `({ text: document.querySelector("#progress").textContent,
        keeperWorking: document.querySelectorAll("#cards .card.working").length,
        keeperHasContent: document.querySelector("#cards .card .breaks")?.textContent ?? "" })`);
  check("finished agent's card is filled while others run", /armour claim is inferred/i.test(p.keeperHasContent), p.keeperHasContent.slice(0, 60));
  check("still-running agent stays marked working", p.keeperWorking === 1, String(p.keeperWorking));
  check("stage 2 reports done vs waiting", /1 done/.test(p.text), p.text.slice(0, 200));

  await sendEvent({ type: "agent-done", result: {
    agent: "devils-advocate", focus: null, elapsedMs: 120000, model: "m", provider: "nvidia", text: "**Finding**\n\nx" } });
  await sendEvent({ type: "agent-start", agent: "coordinator", focus: null });
  p = await win.webContents.executeJavaScript(`document.querySelector("#progress").textContent`);
  check("coordinator stage goes live after the wave", /reading every agent's output/.test(p), p.slice(0, 220));
  check("agent wave marked finished", /2 agents finished/.test(p), p.slice(0, 220));

  await sendEvent({ type: "agent-done", result: {
    agent: "coordinator", focus: null, elapsedMs: 60000, model: "m", provider: "nvidia", text: "**Finding**\n\ny" } });
  await win.webContents.executeJavaScript(`stopProgress(); true`);
  p = await win.webContents.executeJavaScript(`document.querySelector("#progress").textContent`);
  check("run reports a finished total", /Finished in/.test(p), p.slice(-80));

  // --- Fix 1: navigating away mid-run must not lose the run ---------------
  // The IPC exists and is empty before anything has run.
  const emptyRun = await win.webContents.executeJavaScript(`window.mun.council.liveRun()`);
  check("liveRun IPC is reachable and empty before any run", emptyRun === null, String(emptyRun));

  // Populating liveRun for real needs a full priced council run, so the
  // restore path is exercised against a stubbed snapshot of exactly the shape
  // the main process stores. What is under test here is the renderer rebuild.
  const snapshot = {
    active: true,
    startedAt: Date.now() - 240000,
    question: "Which of my weaknesses can be exploited at this table?",
    characters: ["Doctor Doom"],
    answer: null,
    error: null,
    events: [
      { type: "router", decision: { outcome: "proceed", reply: null, rawAgents: [], corrections: [],
        agents: [{ name: "canon-keeper", focus: null }, { name: "devils-advocate", focus: null }, { name: "coordinator", focus: null }] } },
      { type: "agent-start", agent: "canon-keeper", focus: null },
      { type: "agent-start", agent: "devils-advocate", focus: null },
      { type: "agent-done", result: { agent: "canon-keeper", focus: null, elapsedMs: 90000,
        model: "m", provider: "nvidia", text: "**Finding**\n\nArmour dependency. [COMICS]\n\n**Where this breaks**\n\nInferred, not stated.\n\n**Recommendation**\n\nPress ego.\n\n**If I am wrong**\n\nStale source." } },
    ],
  };

  let nav = new Promise(r => win.webContents.once("did-finish-load", r));
  await win.webContents.executeJavaScript(`window.mun.navigate("settings.html")`);
  await nav;
  nav = new Promise(r => win.webContents.once("did-finish-load", r));
  await win.webContents.executeJavaScript(`window.mun.navigate("council.html")`);
  await nav;

  // Stub the snapshot in, then run the same restore the page runs on load.
  await win.webContents.executeJavaScript(`restoreLiveRun(${JSON.stringify(snapshot)})`);
  await new Promise(r => setTimeout(r, 400));

  const restored = await win.webContents.executeJavaScript(
    `({ cards: document.querySelectorAll("#cards .card").length,
        progressHidden: document.querySelector("#progress").hidden,
        progressText: document.querySelector("#progress").textContent,
        keeperContent: document.querySelector("#cards .card .breaks")?.textContent ?? "",
        working: document.querySelectorAll("#cards .card.working").length,
        question: document.querySelector("#question").value,
        askDisabled: document.querySelector("#ask").disabled })`);

  check("returning from Settings restores the cards", restored.cards === 2, String(restored.cards));
  check("returning restores the finished card content", /Inferred, not stated/.test(restored.keeperContent), restored.keeperContent.slice(0,50));
  check("returning keeps the unfinished agent marked working", restored.working === 1, String(restored.working));
  check("returning restores the progress display", restored.progressHidden === false);
  check("restored progress names the in-flight agent", /devils-advocate/.test(restored.progressText));
  check("restored elapsed continues from the original ask", /Elapsed 2[0-9][0-9]s|Elapsed 24[0-9]s/.test(restored.progressText), restored.progressText.slice(-70));
  check("returning restores the question text", restored.question.includes("weaknesses"), restored.question.slice(0,40));
  check("ask stays disabled while the run is still going", restored.askDisabled === true);


  // Finishing while the delegate is elsewhere must still land on the screen.
  await sendEvent({ type: "agent-done", result: {
    agent: "devils-advocate", focus: null, elapsedMs: 120000, model: "m", provider: "nvidia", text: "**Finding**\n\nz" } });
  await sendEvent({ type: "done", answer: {
    outcome: "proceed", question: "q", reply: null, headline: "**Finding**\n\nSynthesis here.", gaps: ["a gap"],
    results: [], failedAgents: [], characters: ["Doctor Doom"], askedAt: new Date().toISOString(), router: null } });
  await new Promise(r => setTimeout(r, 300));

  const after = await win.webContents.executeJavaScript(
    `({ headlineHidden: document.querySelector("#headline-section").hidden,
        headline: document.querySelector("#headline").textContent,
        askDisabled: document.querySelector("#ask").disabled })`);
  check("a run finishing on another screen still shows its answer", after.headlineHidden === false && /Synthesis here/.test(after.headline));
  check("ask is re-enabled once the run ends", after.askDisabled === false);

  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  log(failures === 0 ? "All progress checks passed." : `${failures} failed.`);
  app.exit(failures === 0 ? 0 : 1);
});
