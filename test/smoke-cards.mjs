/*
 * MUN Advisory Council — Copyright (C) 2026 MUN Advisory Council contributors
 * Licensed under the GNU Affero General Public License v3 or later.
 * See the LICENSE file in the project root for the full text.
 */

/**
 * Long content is clamped to a readable height with an expand toggle, and no
 * region silently crops.
 *
 * Covers two fixes. First, cards that cropped their text and did not reflow on
 * resize: grid items stretch to the tallest card in the row by default and
 * refuse to shrink below their longest unbreakable word. Second, the manual
 * expand/collapse now applied to every region that can run long.
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
          bodyHasToggle: !!(body.nextElementSibling &&
            body.nextElementSibling.classList.contains("expand-toggle")),
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
    // Vertical clipping is now intentional: long content is clamped and given
    // a toggle. What must never happen is clipping with no way to reveal it.
    check(`no card body is clipped without a way to expand it at ${width}px`,
      m.cards.every((c) => c.bodyScroll <= c.bodyClient + 1 || c.bodyHasToggle),
      m.cards.map((c) => `${c.agent} ${c.bodyScroll}>${c.bodyClient} toggle=${c.bodyHasToggle}`).join(", "));
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

  // --- manual expand / collapse ------------------------------------------
  // Give the headline and the gap list real content to clamp.
  await send({ type: "done", answer: {
    outcome: "proceed", question: "q", reply: null, router: null, results: [],
    failedAgents: [], characters: ["Doctor Doom"], askedAt: new Date().toISOString(),
    headline: LONG,
    gaps: Array.from({ length: 18 }, (_, i) => `Doctor Doom [COMICS] Marvel Comics: source gap number ${i + 1}`),
  } });
  await new Promise(r => setTimeout(r, 400));

  const regions = () => win.webContents.executeJavaScript(`
    (() => {
      const pick = (sel) => {
        const n = document.querySelector(sel);
        if (!n) return null;
        const t = n.nextElementSibling;
        return {
          clamped: n.classList.contains("clamped"),
          maxHeight: n.style.maxHeight,
          client: n.clientHeight,
          scroll: n.scrollHeight,
          hasToggle: !!(t && t.classList.contains("expand-toggle")),
          toggleText: t && t.classList.contains("expand-toggle") ? t.textContent : null,
          toggleHidden: t && t.classList.contains("expand-toggle") ? t.hidden : null,
          expanded: t && t.classList.contains("expand-toggle") ? t.getAttribute("aria-expanded") : null,
        };
      };
      return {
        headline: pick("#headline .headline-content"),
        gaps: pick("#gaps"),
        longBody: pick("#cards .card .body"),
        longBreaks: pick("#cards .card .breaks"),
        shortBreaks: pick("#cards .card:nth-child(2) .breaks"),
      };
    })()`);

  let r = await regions();

  check("headline is clamped by default", r.headline?.clamped === true);
  check("headline clamp actually limits height",
    r.headline && r.headline.client < r.headline.scroll, `${r.headline?.client} of ${r.headline?.scroll}`);
  check("headline offers a toggle", r.headline?.hasToggle === true);
  check("headline toggle starts collapsed",
    r.headline?.toggleText === "Show more" && r.headline?.expanded === "false");

  check("long agent card body is clamped by default", r.longBody?.clamped === true);
  check("long card body offers a toggle", r.longBody?.hasToggle === true);
  check("long 'where this breaks' is clamped", r.longBreaks?.clamped === true);
  check("source gap list is clamped", r.gaps?.clamped === true);
  check("gap list offers a toggle", r.gaps?.hasToggle === true);

  // Content that already fits must not get a pointless control.
  check("short content gets no toggle", r.shortBreaks?.hasToggle === false,
    `hasToggle=${r.shortBreaks?.hasToggle}`);
  check("short content is not clamped", r.shortBreaks?.clamped === false);

  // Expanding must reveal the whole thing.
  await win.webContents.executeJavaScript(`
    document.querySelector("#headline .headline-content").nextElementSibling.click(); true`);
  await new Promise(r2 => setTimeout(r2, 250));
  r = await regions();
  check("clicking the toggle expands the headline to full height",
    r.headline?.clamped === false && r.headline.client >= r.headline.scroll - 1,
    `${r.headline?.client} of ${r.headline?.scroll}`);
  check("toggle label flips to Show less", r.headline?.toggleText === "Show less");
  check("toggle reports expanded to assistive tech", r.headline?.expanded === "true");

  // And collapsing again must restore the clamp.
  await win.webContents.executeJavaScript(`
    document.querySelector("#headline .headline-content").nextElementSibling.click(); true`);
  await new Promise(r2 => setTimeout(r2, 250));
  r = await regions();
  check("clicking again re-collapses the headline",
    r.headline?.clamped === true && r.headline.client < r.headline.scroll);
  check("toggle label flips back", r.headline?.toggleText === "Show more");

  // Collapsing the card must take its toggle with it, not strand it.
  await win.webContents.executeJavaScript(`
    document.querySelectorAll("#cards .card > .head").forEach(h => h.click()); true`);
  await new Promise(r2 => setTimeout(r2, 250));
  const collapsed = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll("#cards .card .body")].map(b => b.hidden)`);
  check("cards still collapse after the layout change", collapsed.every(Boolean), JSON.stringify(collapsed));

  r = await regions();
  check("a hidden card body hides its toggle too", r.longBody?.toggleHidden === true);
  check("the visible half keeps its toggle", r.longBreaks?.toggleHidden === false);

  const stranded = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll("#cards .expand-toggle")]
      .filter(t => !t.hidden && t.previousElementSibling.hidden).length`);
  check("no toggle is left pointing at hidden content", stranded === 0, String(stranded));

  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  log(failures === 0 ? "\nAll card layout checks passed." : `\n${failures} failed.`);
  app.exit(failures === 0 ? 0 : 1);
});
