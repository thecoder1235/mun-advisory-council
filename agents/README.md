# Agent directives

Every agent in this project is a markdown file in this directory. They are
**read from disk at call time, not compiled in** — edit one and the next
question uses it. No rebuild, no reinstall. In a packaged build they ship
alongside the app rather than inside the archive, so they stay editable there
too.

Tuning these is the main lever the app has. If you came here for the prompt
engineering rather than the Electron app, this directory is the interesting
part and it stands on its own.

---

## How a prompt is assembled

For every call, the system message is built as:

```
shared-rules.md
      +
<the agent's own file>
      +
"## Focus for this question"  ← optional, one line from the router
```

`shared-rules.md` always comes first and **explicitly overrides** anything an
individual directive says. That is deliberate: the rules that keep the system
honest — never invent, tag the canon, no flattery — must not be defeatable by a
single badly-worded agent file.

The router's focus note is *appended*, never substituted. It narrows an agent's
attention for one question; it cannot redefine the agent's role or send it
outside its domain.

Assembly lives in [`../src/agents/loader.ts`](../src/agents/loader.ts).

---

## The shared contract

Everything in `shared-rules.md` binds every agent. Four parts matter most.

**Never invent.** The single most important rule in the system:

> Mark anything not directly supported by the supplied source text with
> `[UNVERIFIED]`. Do not fill gaps from memory. Comic and film continuity
> branches heavily, published versions contradict each other, and a fabricated
> detail that gets challenged in committee is worse than no answer at all.

**Canon tagging.** Every factual claim carries `[COMICS]`, `[FILM]` or
`[BOTH]`. Where continuities conflict, both readings are given rather than
averaged — the conflict is usually the most useful output, because it tells the
delegate which claims an opponent can contest.

**The four headings.** Every response uses exactly these, in this order:

| Heading | Contains |
|---|---|
| **Finding** | What you determined, in your domain only. |
| **Where this breaks** | The specific point at which this fails. May never be empty, and may never be filled with praise. |
| **Recommendation** | Concrete action. |
| **If I'm wrong** | The most likely reason your assessment is mistaken. |

The UI parses these headings, and cards open on **Where this breaks** rather
than on the finding. An agent that drops a heading degrades the interface, not
just the prose.

**No flattery.** Opening with praise is banned outright, by listed phrase. A
council that validates the delegate hides the blind spots it exists to expose.

---

## The agents

| File | Role | Gets raw wiki text? |
|---|---|---|
| [`shared-rules.md`](shared-rules.md) | Prepended to every agent below | — |
| [`router.md`](router.md) | Triage; decides who wakes, or that nobody does | no |
| [`canon-keeper.md`](canon-keeper.md) | Extracts facts from source; everything builds on it | **yes** |
| [`vulnerability-mapper.md`](vulnerability-mapper.md) | Maps weaknesses to who can exploit them, and at what cost | **yes** |
| [`crisis-forecaster.md`](crisis-forecaster.md) | Predicts what the chair introduces next | **yes** |
| [`alliance-strategist.md`](alliance-strategist.md) | Reads the table as a network of interests | **yes** |
| [`devils-advocate.md`](devils-advocate.md) | Attacks the delegate's plan | **yes** |
| [`coordinator.md`](coordinator.md) | Writes the headline answer, surfaces disagreement | no |
| [`user-guide.md`](user-guide.md) | Reference text the app quotes for "how do I use this" | — |

`router.md` and `user-guide.md` are the two exceptions to the format above. The
router returns **JSON only** and the four headings do not apply to it;
`user-guide.md` is not a directive at all but reference prose the app reads out
when the router classifies a message as `help`.

Which agents receive raw wiki text — and which sections of it — is configured in
[`../src/wiki/sections.ts`](../src/wiki/sections.ts), not here.

---

## Editing an agent

Change the file, ask another question. That is the whole loop.

Worth knowing before you do:

- **Keep the four headings** unless you also change the UI parser and the
  grounding audit, both of which look for them by name.
- **Do not weaken the marker rules.** `[UNVERIFIED]` and the canon tags are
  load-bearing: the audit in
  [`../src/cli/grounding.ts`](../src/cli/grounding.ts) counts them, and the UI
  renders them as coloured chips.
- **Stay in the agent's lane.** Agents are told to write one line and stop if a
  question falls outside their domain. Broadening a directive to cover more
  ground tends to produce confident answers about things the agent has no
  source for.
- **Re-verify after editing.** `npm run tool:agent -- --agent canon-keeper --ask "..."`
  runs one agent and prints the raw output followed by a grounding audit — but
  it **costs a real model call**, so read the warning at the top of that file
  first.

## Adding an agent

1. Write `agents/your-agent.md` following the format above.
2. Add its name to `ALL_AGENTS` in
   [`../src/council/router.ts`](../src/council/router.ts).
3. List it in `router.md` so the router knows it can select it.
4. If it needs raw wiki text, give it a section profile and a budget in
   [`../src/wiki/sections.ts`](../src/wiki/sections.ts); without one it receives
   the canon-keeper's output instead.

The router enforces its constraints in code, not in the prompt: a minimum of
three agents, `devils-advocate` and `coordinator` always included, and unknown
names dropped. A new agent that `router.md` never mentions will simply never be
selected — though the delegate can still wake it by hand from the UI.
