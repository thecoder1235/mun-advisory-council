/*
 * MUN Advisory Council — Copyright (C) 2026 MUN Advisory Council contributors
 * Licensed under the GNU Affero General Public License v3 or later.
 * See the LICENSE file in the project root for the full text.
 */

/**
 * The committee screen.
 *
 * Two ideas drive the layout. Cards stream in as each agent settles, because a
 * delegate under time pressure should not wait on the slowest agent to see the
 * first one. And every card opens on "Where this breaks" rather than the
 * finding — the failure mode this app exists to prevent is a delegate carrying
 * a confident claim into committee without knowing where it can be contested.
 */

const $ = (id) => document.getElementById(id);

/** Characters currently at the table: name -> per-wiki fetch outcome. */
const table = new Map();
/** Agents the delegate woke by hand, on top of the router's selection. */
const forced = new Set();
let asking = false;

// --- rendering helpers ------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Render the canon and verification markers as visible chips.
 *
 * Escaping happens here rather than anywhere else: everything on this screen is
 * model output or wiki text, so nothing is ever inserted as trusted HTML.
 */
function withMarkers(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/\[COMICS\]/g, '<span class="tag comics">COMICS</span>')
    .replace(/\[FILM\]/g, '<span class="tag film">FILM</span>')
    .replace(/\[BOTH\]/g, '<span class="tag comics">BOTH</span>')
    .replace(/\[UNVERIFIED\]/g, '<span class="tag unver">UNVERIFIED</span>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** Split an agent answer into the four standard headings. */
function splitSections(text) {
  const names = ["Finding", "Where this breaks", "Recommendation", "If I'm wrong"];
  const found = [];

  for (const name of names) {
    const pattern = new RegExp(`^\\s*(?:#+\\s*)?\\*{0,2}${name.replace(/'/g, "['’]")}\\*{0,2}\\s*:?\\s*$`, "im");
    const match = pattern.exec(text);
    if (match) found.push({ name, index: match.index, length: match[0].length });
  }
  found.sort((a, b) => a.index - b.index);

  if (found.length === 0) return [{ name: "Answer", body: text.trim() }];

  const out = [];
  // Anything before the first heading is preamble and would otherwise vanish.
  const preamble = text.slice(0, found[0].index).trim();
  if (preamble) out.push({ name: "Answer", body: preamble });

  found.forEach((h, i) => {
    const end = i + 1 < found.length ? found[i + 1].index : text.length;
    out.push({ name: h.name, body: text.slice(h.index + h.length, end).trim() });
  });
  return out;
}

/** Very small markdown: paragraphs and bullet lists, with markers preserved. */
function renderBody(container, body) {
  const lines = body.split("\n");
  let list = null;

  const flush = () => {
    if (list) {
      container.append(list);
      list = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      if (!list) list = document.createElement("ul");
      const li = document.createElement("li");
      li.innerHTML = withMarkers(bullet[1]);
      list.append(li);
      continue;
    }
    flush();
    const p = document.createElement("p");
    p.innerHTML = withMarkers(trimmed);
    container.append(p);
  }
  flush();
}

// --- character panel --------------------------------------------------------

function renderChars() {
  const host = $("chars");
  host.innerHTML = "";

  for (const [name, results] of table) {
    const card = el("div", "char");
    const head = el("div", "name");
    head.append(el("span", null, name));

    const remove = el("button", "small", "Remove");
    remove.addEventListener("click", () => {
      table.delete(name);
      renderChars();
    });
    head.append(remove);
    card.append(head);

    for (const r of results) {
      const row = el("div", "src");
      const tag = el("span", `tag ${r.canon === "COMICS" ? "comics" : "film"}`, r.canon);
      row.append(tag);

      if (r.status === "found") {
        row.append(el("span", "ok", "✓"));
        row.append(el("span", null, r.title));
      } else if (r.status === "missing") {
        row.append(el("span", "no", "—"));
        // Absence is stated, never left to look like it was simply not checked.
        row.append(el("span", null, `no page (${r.reason.replace(/_/g, " ")})`));
      } else {
        row.append(el("span", "er", "!"));
        row.append(el("span", null, "fetch failed"));
      }
      card.append(row);

      // Continuity preference is a default, not a verdict: let the delegate
      // switch to the incarnation they are actually playing.
      if (r.status === "found" && r.alternatives && r.alternatives.length > 0) {
        const wrap = el("div", "alts");
        wrap.append(el("div", null, "Other versions:"));
        const select = document.createElement("select");
        select.append(new Option(r.title, r.title));
        for (const alt of r.alternatives) select.append(new Option(alt, alt));
        select.value = r.title;
        select.addEventListener("change", async () => {
          if (select.value === r.title) return;
          setStatus($("char-status"), `Loading ${select.value}…`, "");
          const res = await window.mun.council.addCharacter(name, { [r.wikiId]: select.value });
          if (res.ok) {
            table.set(name, res.dossier.results);
            renderChars();
            setStatus($("char-status"), `Switched to ${select.value}.`, "");
          } else {
            setStatus($("char-status"), res.message, "err");
          }
        });
        wrap.append(select);
        card.append(wrap);
      }
    }
    host.append(card);
  }
}

function setStatus(node, text, kind) {
  node.textContent = text;
  node.className = `status ${kind ?? ""}`;
}

function startProgress(node, label) {
  const began = Date.now();
  const tick = () => {
    const secs = Math.round((Date.now() - began) / 1000);
    node.innerHTML = `<span class="spinner"></span>${label} (${secs}s)`;
    node.className = "status";
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

async function addCharacter(name) {
  const trimmed = name.trim();
  if (trimmed === "") return;
  const stop = startProgress($("char-status"), `Looking up ${trimmed}`);
  try {
    const res = await window.mun.council.addCharacter(trimmed);
    stop();
    if (!res.ok) {
      setStatus($("char-status"), res.message, "err");
      return;
    }
    table.set(res.dossier.query, res.dossier.results);
    renderChars();
    $("char-input").value = "";

    const found = res.dossier.results.filter((r) => r.status === "found").length;
    setStatus(
      $("char-status"),
      found === 0
        ? `No page for "${trimmed}" on any of the four wikis. Check the spelling, or try their real name.`
        : `${trimmed}: ${found} of 4 wikis have a page.`,
      found === 0 ? "err" : "",
    );
  } catch (err) {
    stop();
    setStatus($("char-status"), `Could not load: ${err.message ?? err}`, "err");
  }
}

$("char-add").addEventListener("click", () => addCharacter($("char-input").value));
$("char-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void addCharacter($("char-input").value);
  }
});

for (const btn of document.querySelectorAll("#examples button")) {
  btn.addEventListener("click", () => {
    $("question").value = btn.dataset.q;
    $("question").focus();
  });
}

// --- cards ------------------------------------------------------------------

const cardNodes = new Map();

function cardFor(agent) {
  let node = cardNodes.get(agent);
  if (node) return node;

  node = el("div", "card working");
  const head = el("div", "head");
  head.append(el("span", "agent", agent));

  // A per-agent second counter. A cold agent can take two minutes, and without
  // a moving number that is indistinguishable from the app having frozen.
  const elapsed = el("span", "elapsed", "0s");
  head.append(elapsed);
  const began = Date.now();
  const timer = setInterval(() => {
    elapsed.textContent = `${Math.round((Date.now() - began) / 1000)}s`;
  }, 1000);

  const chev = el("span", "chev", "▸");
  head.append(chev);

  const breaks = el("div", "breaks");
  const body = el("div", "body");
  body.hidden = true;

  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    breaks.hidden = !body.hidden;
    chev.textContent = body.hidden ? "▸" : "▾";
  });

  node.append(head, breaks, body);
  node._parts = { head, breaks, body, chev, elapsed, timer };
  cardNodes.set(agent, node);
  $("cards").append(node);
  return node;
}

function fillCard(result) {
  const node = cardFor(result.agent);
  node.classList.remove("working");
  const { breaks, body, elapsed, timer } = node._parts;
  clearInterval(timer);
  elapsed.textContent = `${Math.round(result.elapsedMs / 1000)}s`;

  if (result.error) {
    node.classList.add("failed");
    breaks.innerHTML = "<strong>Agent failed</strong>";
    breaks.append(el("div", null, result.error));
    body.innerHTML = "";
    return;
  }

  const sections = splitSections(result.text);

  // Collapsed state shows only "Where this breaks" — the part a delegate most
  // needs and is least likely to seek out on their own.
  const where = sections.find((s) => s.name === "Where this breaks");
  breaks.innerHTML = "";
  breaks.append(el("strong", null, "Where this breaks"));
  if (where) {
    const holder = el("div");
    renderBody(holder, where.body);
    breaks.append(holder);
  } else {
    breaks.append(el("div", null, "(not supplied)"));
  }

  body.innerHTML = "";
  for (const section of sections) {
    const wrap = el("div", "sec");
    wrap.append(el("h4", null, section.name));
    renderBody(wrap, section.body);
    body.append(wrap);
  }

  const meta = el("div", "sec");
  meta.append(
    el(
      "h4",
      null,
      `${result.model || "?"} · ${Math.round(result.elapsedMs / 1000)}s` +
        (result.focus ? ` · focus: ${result.focus}` : ""),
    ),
  );
  body.append(meta);
}

// --- router strip -----------------------------------------------------------

function renderRouter(decision) {
  $("router-section").hidden = false;
  const host = $("router");
  host.innerHTML = "";

  if (decision.outcome !== "proceed") {
    host.append(el("div", "woke", `Router: ${decision.outcome.replace(/_/g, " ")}`));
    return;
  }

  const woke = decision.agents.map((a) => a.name).join(", ");
  host.append(el("div", "woke", `Woke: ${woke}`));

  for (const agent of decision.agents) {
    if (agent.focus) {
      host.append(el("div", null, `${agent.name} — ${agent.focus}`));
    }
  }

  // The router advises; it does not rule. Show where code overruled it.
  if (decision.corrections.length > 0) {
    const corr = el("div", "corr");
    corr.textContent = `Enforced: ${decision.corrections.join("; ")}`;
    host.append(corr);
  }

  const wake = el("div", "wake");
  wake.append(el("span", null, "Wake another:"));
  for (const agent of ALL_AGENTS) {
    if (decision.agents.some((a) => a.name === agent)) continue;
    const btn = el("button", "small", agent);
    btn.addEventListener("click", () => {
      forced.add(agent);
      btn.disabled = true;
      btn.textContent = `${agent} ✓ (next ask)`;
    });
    wake.append(btn);
  }
  if (wake.childElementCount > 1) host.append(wake);
}

let ALL_AGENTS = [];

// --- asking -----------------------------------------------------------------

// --- per-stage progress -----------------------------------------------------

/**
 * The council runs in three sequential stages: router, then every other agent
 * in one parallel wave, then the coordinator. Only the middle stage
 * parallelises, and each stage costs roughly one model cold-start (~2 min on
 * the current deployment), so a full run is ~8-9 minutes.
 *
 * That is far too long to show as an undifferentiated spinner. This tracks
 * which stage is live and which agents are still outstanding inside it, so the
 * wait reads as measurable progress rather than a hang.
 */
const progress = {
  startedAt: 0,
  timer: null,
  stage: "idle", // idle | router | agents | coordinator | done
  routerMs: null,
  running: new Map(), // agent -> start timestamp
  done: [],
  expected: 0,
};

function resetProgress() {
  clearInterval(progress.timer);
  Object.assign(progress, {
    startedAt: Date.now(),
    timer: null,
    stage: "router",
    routerMs: null,
    running: new Map(),
    done: [],
    expected: 0,
  });
  $("progress").hidden = false;
  progress.timer = setInterval(renderProgress, 1000);
  renderProgress();
}

function stopProgress() {
  clearInterval(progress.timer);
  progress.timer = null;
  progress.stage = "done";
  renderProgress();
}

function secs(ms) {
  return `${Math.round(ms / 1000)}s`;
}

function stageRow(state, label, detail, timing) {
  const row = el("div", `stage ${state}`);
  row.append(el("span", "mark", state === "done" ? "✓" : state === "running" ? "●" : "○"));
  row.append(el("span", "label", label));
  row.append(el("span", "detail", detail));
  row.append(el("span", "secs", timing));
  return row;
}

function renderProgress() {
  const host = $("progress");
  if (host.hidden) return;
  host.innerHTML = "";
  const now = Date.now();
  const order = ["router", "agents", "coordinator", "done"];
  const at = order.indexOf(progress.stage);

  // Stage 1 — router.
  host.append(
    stageRow(
      at > 0 ? "done" : "running",
      "1. Router",
      at > 0 ? "decided which agents wake" : "deciding which agents wake…",
      progress.routerMs === null ? "" : secs(progress.routerMs),
    ),
  );

  // Stage 2 — the parallel wave. Name the agents still outstanding: with a
  // wave capped by its slowest member, knowing who that is explains the wait.
  const waveDone = progress.done.filter((d) => d.agent !== "coordinator");
  const waveRunning = [...progress.running.keys()].filter((a) => a !== "coordinator");
  let waveState = "pending";
  let waveDetail = "waiting for the router";
  if (at === 1) {
    waveState = "running";
    waveDetail =
      waveRunning.length > 0
        ? `${waveDone.length} done · waiting on ${waveRunning
            .map((a) => `${a} (${secs(now - progress.running.get(a))})`)
            .join(", ")}`
        : `${waveDone.length} done`;
  } else if (at > 1) {
    waveState = "done";
    waveDetail = `${waveDone.length} agent${waveDone.length === 1 ? "" : "s"} finished`;
  }
  host.append(
    stageRow(
      waveState,
      `2. Agents${progress.expected ? ` (${progress.expected})` : ""}`,
      waveDetail,
      "",
    ),
  );

  // Stage 3 — coordinator.
  const coordRunning = progress.running.has("coordinator");
  const coordDone = progress.done.find((d) => d.agent === "coordinator");
  host.append(
    stageRow(
      coordDone ? "done" : coordRunning ? "running" : "pending",
      "3. Coordinator",
      coordDone
        ? "synthesis written"
        : coordRunning
          ? "reading every agent's output…"
          : "waits for all agents to finish",
      coordDone ? secs(coordDone.elapsedMs) : coordRunning ? secs(now - progress.running.get("coordinator")) : "",
    ),
  );

  const total = el("div", "total");
  total.textContent =
    progress.stage === "done"
      ? `Finished in ${secs(now - progress.startedAt)}.`
      : `Elapsed ${secs(now - progress.startedAt)} — a full council usually takes 8–9 minutes.`;
  host.append(total);
}

function handleCouncilEvent(event) {
  if (!event) return;

  if (event.type === "router") {
    renderRouter(event.decision);
    progress.routerMs = Date.now() - progress.startedAt;
    progress.stage = event.decision.outcome === "proceed" ? "agents" : "done";
    progress.expected = (event.decision.agents ?? []).filter((a) => a.name !== "coordinator").length;
    renderProgress();
    return;
  }

  if (event.type === "agent-start") {
    // Cards are created the moment an agent starts and filled the moment it
    // returns, so canon-keeper is readable while the coordinator is still out.
    $("cards-section").hidden = false;
    cardFor(event.agent);
    progress.running.set(event.agent, Date.now());
    if (event.agent === "coordinator") progress.stage = "coordinator";
    renderProgress();
    return;
  }

  if (event.type === "agent-done") {
    fillCard(event.result);
    progress.running.delete(event.result.agent);
    progress.done.push(event.result);
    renderProgress();
    return;
  }

  // Terminal events. These matter most for a page that navigated away and back
  // during the run: it no longer holds the original invoke promise, so this is
  // the only way it learns the council finished.
  if (event.type === "done") {
    stopProgress();
    asking = false;
    $("ask").disabled = false;
    void renderAnswer(event.answer);
    return;
  }

  if (event.type === "failed") {
    stopProgress();
    asking = false;
    $("ask").disabled = false;
    setStatus($("ask-status"), `Failed: ${event.message}`, "err");
  }
}

window.mun.council.onEvent(handleCouncilEvent);

/**
 * Rebuild the screen from a run that is still going, or has finished while the
 * delegate was on another screen. Replays the recorded events through the same
 * handler that draws them live, so the restored view is the live view.
 */
async function restoreLiveRun(injected) {
  // The snapshot is injectable so the restore path can be exercised without
  // paying for a real council run; normal callers pass nothing.
  let run = injected ?? null;
  if (run === null) {
    try {
      run = await window.mun.council.liveRun();
    } catch {
      return false;
    }
  }
  if (!run) return false;

  $("question").value = run.question ?? "";
  resetProgress();
  // Keep the original clock: elapsed must keep counting from when the delegate
  // actually asked, not from when they came back to the screen.
  progress.startedAt = run.startedAt ?? Date.now();

  for (const event of run.events ?? []) handleCouncilEvent(event);

  if (run.active) {
    asking = true;
    $("ask").disabled = true;
    startProgress($("ask-status"), "Consulting the council");
  } else {
    stopProgress();
    if (run.error) setStatus($("ask-status"), `Failed: ${run.error}`, "err");
    else await renderAnswer(run.answer);
  }
  return true;
}

/**
 * Render a finished answer. Shared by the live path and by a page that
 * navigated away mid-run and is rebuilding itself, so both show the same thing.
 * Idempotent: safe to call twice for the same answer.
 */
async function renderAnswer(answer) {
  if (!answer) return;

  // Non-proceed outcomes wake nobody; show the router's own short reply.
  if (answer.outcome !== "proceed") {
    $("headline-section").hidden = false;
    const host = $("headline");
    host.innerHTML = "";
    host.append(el("h3", null, "Reply"));
    renderBody(host, answer.reply ?? "(no reply)");

    if (answer.outcome === "help") {
      const guide = await window.mun.council.guide();
      if (guide.ok) {
        $("guide-body").textContent = guide.text;
        $("guide-dialog").showModal();
      }
    }
    setStatus($("ask-status"), "", "");
    return;
  }

  if (answer.headline) {
    $("headline-section").hidden = false;
    const host = $("headline");
    host.innerHTML = "";
    host.append(el("h3", null, "Coordinator"));
    for (const section of splitSections(answer.headline)) {
      const wrap = el("div", "sec");
      wrap.append(el("h4", null, section.name));
      renderBody(wrap, section.body);
      host.append(wrap);
    }
  }

  if ((answer.gaps ?? []).length > 0) {
    $("gaps-section").hidden = false;
    const list = $("gaps");
    list.innerHTML = "";
    for (const gap of answer.gaps) list.append(el("li", null, gap));
  }

  // Rate limits and cold GPUs will cost the odd agent mid-committee. Offer to
  // recover just those rather than paying for the whole council again.
  const failed = answer.failedAgents ?? [];
  if (failed.length > 0) {
    const host = $("ask-status");
    host.className = "status err";
    host.innerHTML = "";
    host.append(el("span", null, `${failed.length} agent(s) failed: ${failed.join(", ")}. `));
    const retry = el("button", "small", "Retry those agents");
    retry.addEventListener("click", () => {
      for (const agent of failed) forced.add(agent);
      void ask();
    });
    host.append(retry);
  } else {
    setStatus($("ask-status"), "", "");
  }
}

async function ask() {
  if (asking) return;
  const question = $("question").value.trim();
  if (question === "") {
    setStatus($("ask-status"), "Type a question first.", "err");
    return;
  }

  asking = true;
  $("ask").disabled = true;
  cardNodes.clear();
  $("cards").innerHTML = "";
  $("cards-section").hidden = true;
  $("headline-section").hidden = true;
  $("gaps-section").hidden = true;
  $("router-section").hidden = true;

  resetProgress();
  const stop = startProgress($("ask-status"), "Consulting the council");
  try {
    const res = await window.mun.council.ask(question, [...table.keys()], [...forced]);
    stop();
    stopProgress();
    forced.clear();

    if (!res.ok) {
      setStatus($("ask-status"), res.message, "err");
      return;
    }

    await renderAnswer(res.answer);
  } catch (err) {
    stop();
    stopProgress();
    setStatus($("ask-status"), `Failed: ${err.message ?? err}`, "err");
  } finally {
    asking = false;
    $("ask").disabled = false;
  }
}

$("ask").addEventListener("click", ask);

// --- history and settings ---------------------------------------------------

$("btn-settings").addEventListener("click", () => window.mun.navigate("settings.html"));
$("hist-close").addEventListener("click", () => $("history-dialog").close());
$("guide-close").addEventListener("click", () => $("guide-dialog").close());

$("btn-history").addEventListener("click", async () => {
  const body = $("hist-body");
  body.innerHTML = "Loading…";
  $("history-dialog").showModal();

  const entries = await window.mun.council.history();
  body.innerHTML = "";
  if (entries.length === 0) {
    body.append(el("div", null, "No earlier questions yet."));
    return;
  }

  for (const entry of entries) {
    const row = el("div", "hist");
    row.append(el("div", "q", entry.question));
    row.append(
      el(
        "div",
        "m",
        `${new Date(entry.askedAt).toLocaleString()} · ${entry.characters.join(", ") || "no characters"} · ${entry.agentCount} agents`,
      ),
    );
    row.addEventListener("click", async () => {
      const res = await window.mun.council.answer(entry.id);
      if (!res.ok) return;
      $("history-dialog").close();
      replay(res.answer);
    });
    body.append(row);
  }
});

/** Re-render a stored answer exactly as it was produced. */
function replay(answer) {
  cardNodes.clear();
  $("cards").innerHTML = "";
  $("question").value = answer.question;

  if (answer.router) renderRouter(answer.router);

  if (answer.headline) {
    $("headline-section").hidden = false;
    const host = $("headline");
    host.innerHTML = "";
    host.append(el("h3", null, "Coordinator"));
    for (const section of splitSections(answer.headline)) {
      const wrap = el("div", "sec");
      wrap.append(el("h4", null, section.name));
      renderBody(wrap, section.body);
      host.append(wrap);
    }
  }

  if (answer.results.length > 0) {
    $("cards-section").hidden = false;
    for (const result of answer.results) fillCard(result);
  }

  if (answer.gaps.length > 0) {
    $("gaps-section").hidden = false;
    const list = $("gaps");
    list.innerHTML = "";
    for (const gap of answer.gaps) list.append(el("li", null, gap));
  }
}

(async () => {
  ALL_AGENTS = await window.mun.council.agents();

  // Before anything else: if a run is in flight or just finished, put the
  // screen back the way it was rather than showing a blank page.
  await restoreLiveRun();

  // Set expectations before the first question rather than after it. The wait
  // is inherent to the provider — each stage pays a fresh GPU cold start — so
  // the honest thing is to say so upfront instead of letting an 8-minute
  // silence read as a broken app.
  try {
    const history = await window.mun.council.history();
    const note = $("timing-note");
    if ((history ?? []).length === 0) {
      note.className = "timing-note first-run";
      note.textContent =
        "Before your first question: a full council takes roughly 8–9 minutes. " +
        "The agents run in three stages and each one waits for NVIDIA to start a GPU, " +
        "which is about two minutes every time. Progress is shown stage by stage, and " +
        "each agent's card appears as soon as that agent finishes — you can start reading " +
        "before the rest are done.";
    } else {
      note.className = "timing-note";
      note.textContent = "A full council takes roughly 8–9 minutes; cards appear as each agent finishes.";
    }
  } catch {
    /* the note is optional; never block the screen on it */
  }
})();


// --- model readiness --------------------------------------------------------

/**
 * The first call to a cold model waits on GPU provisioning, measured at 84-111s.
 * The app starts warming at launch, and this says where that has got to — so a
 * slow first question reads as "the model is starting" rather than "the app is
 * broken".
 */
function renderWarmth(status) {
  const host = $("warmth");
  if (!host || !status) return;
  host.className = `warmth ${status.state}`;
  host.innerHTML = "";
  host.append(el("span", "dot"));

  const label =
    status.state === "warm"
      ? `Model ready${status.lastLatencyMs ? ` (${(status.lastLatencyMs / 1000).toFixed(1)}s)` : ""}`
      : status.state === "warming"
        ? "Starting model…"
        : status.state === "failed"
          ? "Model not reachable"
          : "Model idle";
  host.append(el("span", null, label));
  host.title = status.message || label;

  // Asking while cold is allowed, but the wait should not be a surprise.
  const ask = $("ask");
  if (ask && !asking) {
    ask.textContent = status.state === "warm" ? "Ask the council" : "Ask the council (model still starting)";
  }
}

window.mun.warmth.onChange(renderWarmth);
(async () => {
  renderWarmth(await window.mun.warmth.status());
})();
