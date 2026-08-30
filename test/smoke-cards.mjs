/*
 * MUN Advisory Council — Copyright (C) 2026 MUN Advisory Council contributors
 * Licensed under the GNU Affero General Public License v3 or later.
 * See the LICENSE file in the project root for the full text.
 */

/**
 * Agent cards must show all of their content and survive a narrow window.
 *
 * Regression test for cards that cropped their text and did not reflow on
 * resize: grid items stretch to the tallest card in the row by default and
 * refuse to shrink below their longest unbreakable word.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";

const { app } = electron;
const profile = mkdtempSync(join(tmpdir(), "mun-cards-"));
app.setPath("userData", profile);
delete process.env.NVIDIA_API_KEY;

const LOG = "smoke-cards.log";
writeFileSync(LOG, "");
const log = (l) => { appendFileSync(LOG, `${l}\n`); console.log(l); };
process.on("uncaughtException", e => { appendFileSync(LOG, `UNCAUGHT: ${e?.stack ?? e}\n`); app.exit(1); });
process.on("unhandledRejection", e => { appendFileSync(LOG, `REJECTED: ${e?.stack ?? e}\n`); app.exit(1); });

let failures = 0;
const check = (n, ok, d = "") => {
  if (!ok) failures += 1;
  // Detail is diagnostic for a failure; printing it on a pass reads as one.
  log(`${ok ? "PASS" : "FAIL"}  ${n}${!ok && d ? "  — " + d : ""}`);
};

// A long answer next to a short one: the pair that previously cropped.
const LONG = [
  "**Finding**", "",
  ...Array.from({ length: 14 }, (_, i) =>
    `Paragraph ${i + 1}: the supplied source does not document this, and the model id deepseek-ai/deepseek-v4-pro-0813 appears verbatim in a long unbreakable run to test wrapping. [COMICS]`),
  // A genuinely unbreakable run: no hyphen, slash or space for the layout to
  // break on. This is what forces a grid item past its column and, with the
  // page unable to scroll horizontally, off the edge of the window entirely.
  "", "Trace id: " + "A".repeat(90) + " [UNVERIFIED]", "",
  "", "**Where this breaks**", "",
  ...Array.from({ length: 10 }, (_, i) => `- Break point ${i + 1} with more text than fits in a short card.`),
  "", "**Recommendation**", "", "Act only on what the source states.",
  "", "**If I'm wrong**", "", "The retrieved section may be incomplete.",
].join("\n");

const SHORT = "**Finding**\n\nBrief. [FILM]\n\n**Where this breaks**\n\nLittle to say.\n\n**Recommendation**\n\nNone.\n\n**If I'm wrong**\n\nn/a";

app.whenReady().then(async () => {
  const { bootstrap } = await import("../dist/main/app.js");
  const win = await bootstrap();
  await new Promise(r => win.webContents.once("did-finish-load", r));
  const loaded = new Promise(r => win.webContents.once("did-finish-load", r));
  await win.webContents.executeJavaScript(`window.mun.navigate("council.html")`);
  await loaded;
  await new Promise(r => setTimeout(r, 600));

  const send = (p) => { win.webContents.send("council:event", p); return new Promise(r => setTimeout(r, 120)); };

  await win.webContents.executeJavaScript(`resetProgress(); true`);
  await send({ type: "router", decision: { outcome: "proceed", reply: null, rawAgents: [], corrections: [],
    agents: [{ name: "canon-keeper", focus: null }, { name: "devils-advocate", focus: null }] } });
  for (const [agent, text] of [["canon-keeper", LONG], ["devils-advocate", SHORT]]) {
    await send({ type: "agent-start", agent, focus: null });
    await send({ type: "agent-done", result: { agent, focus: null, elapsedMs: 90000, model: "m", provider: "nvidia", text } });
  }

  // Expand both cards, the state in which cropping was visible.
  await win.webContents.executeJavaScript(`
    document.querySelectorAll("#cards .card > .head").forEach(h => h.click()); true`);
  await new Promise(r => setTimeout(r, 300));

  const measure = () => win.webContents.executeJavaScript(`
    (() => {
      const out = [];
      for (const card of document.querySelectorAll("#cards .card")) {
        const body = card.querySelector(".body");
        const cs = getComputedStyle(card);
        out.push({
          agent: card.querySelector(".agent").textContent,
          cardScroll: card.scrollHeight, cardClient: card.clientHeight,
          bodyScroll: body.scrollHeight, bodyClient: body.clientHeight,
          // Horizontal overflow inside the card is the clipping that matters:
          // overflow:hidden swallows it, so the page stays the right width
          // while text is genuinely unreachable.
          bodyScrollW: body.scrollWidth, bodyClientW: body.clientWidth,
          bodyHidden: body.hidden,
          overflow: cs.overflow,
          cardRight: Math.round(card.getBoundingClientRect().right),
        });
      }
      return { cards: out,
               docScrollW: document.documentElement.scrollWidth,
               docClientW: document.documentElement.clientWidth,
               innerW: window.innerWidth };
    })()`);

  /**
   * Viewport size is set with device emulation rather than by resizing the
   * window. `setContentSize` is clamped by the window's own minWidth (720),
   * applies asynchronously, and did not take effect at all on one run — so it
   * silently re-measured the previous size and reported a pass. Emulation sets
   * the viewport directly and is not subject to either problem.
   */
  const setViewport = async (width, height = 900) => {
    win.webContents.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: { width, height },
      viewSize: { width, height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      scale: 1,
    });
    await new Promise((r) => setTimeout(r, 400));
    const actual = await win.webContents.executeJavaScript("window.innerWidth");
    if (actual !== width) throw new Error(`viewport did not apply: asked ${width}, got ${actual}`);
    return actual;
  };

  for (const width of [1280, 700, 420]) {
    await setViewport(width);
    const m = await measure();
    log(`\n${width}px viewport:`);
    for (const c of m.cards) {
      log(`  ${c.agent}: card ${c.cardScroll}/${c.cardClient}, right edge ${c.cardRight}`);
    }

    check(`cards are not clipped at ${width}px`,
      m.cards.every((c) => c.cardScroll <= c.cardClient + 1),
      m.cards.map((c) => `${c.agent} ${c.cardScroll}>${c.cardClient}`).join(", "));
    check(`card bodies are not clipped vertically at ${width}px`,
      m.cards.every((c) => c.bodyScroll <= c.bodyClient + 1));
    check(`card text is not cut off horizontally at ${width}px`,
      m.cards.every((c) => c.bodyScrollW <= c.bodyClientW + 1),
      m.cards.map((c) => `${c.agent} ${c.bodyScrollW}>${c.bodyClientW}`).join(", "));
    check(`no horizontal page overflow at ${width}px`,
      m.docScrollW <= m.docClientW + 1, `${m.docScrollW} > ${m.docClientW}`);
    check(`cards stay inside the viewport at ${width}px`,
      m.cards.every((c) => c.cardRight <= width + 1),
      m.cards.map((c) => c.cardRight).join(", "));

    if (width === 1280) {
      check("cards size to their own content, not the tallest in the row",
        Math.abs(m.cards[0].cardClient - m.cards[1].cardClient) > 50,
        `${m.cards[0].cardClient} vs ${m.cards[1].cardClient}`);
    }
    if (width <= 760) {
      check(`single column at ${width}px`,
        m.cards[0].cardRight === m.cards[1].cardRight,
        `${m.cards[0].cardRight} vs ${m.cards[1].cardRight}`);
    }
  }

  win.webContents.disableDeviceEmulation();
  await new Promise((r) => setTimeout(r, 200));

  // Collapsing must still work.
  await win.webContents.executeJavaScript(`
    document.querySelectorAll("#cards .card > .head").forEach(h => h.click()); true`);
  await new Promise(r => setTimeout(r, 250));
  const collapsed = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll("#cards .card .body")].map(b => b.hidden)`);
  check("cards still collapse after the layout change", collapsed.every(Boolean), JSON.stringify(collapsed));

  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  log(failures === 0 ? "\nAll card layout checks passed." : `\n${failures} failed.`);
  app.exit(failures === 0 ? 0 : 1);
});
