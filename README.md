# MUN Advisory Council

A desktop research assistant for Model UN crisis committees, built around one
constraint: **it will not answer from the model's memory.**

Ask it about a character and it fetches their wiki pages first, then reasons
only from that fetched text. When the source does not cover something, it says
so instead of filling the gap. That is the entire point — a delegate who walks
into committee carrying an invented detail gets it challenged, and loses the
argument they thought they had won.

Built for a Marvel vs DC crisis committee, so it reads from the Marvel and DC
Fandom wikis across both comics and film continuity.

---

## Why grounding is the interesting part

Any chatbot can talk about Doctor Doom. The difficulty is getting one to admit
what it does not know about him, and to mark the difference clearly enough that
you can rely on it under pressure. Several mechanisms enforce that here:

**Everything is fetched, nothing is remembered.** Agents receive extracted wiki
text and are told to work only from it. The instruction that matters most, from
`agents/shared-rules.md`:

> Mark anything not directly supported by the supplied source text with
> `[UNVERIFIED]`. Do not fill gaps from memory. Comic and film continuity
> branches heavily, published versions contradict each other, and a fabricated
> detail that gets challenged in committee is worse than no answer at all.

**Absence is stated, not implied.** If a page has no Weaknesses section, the
agent is told *"Sections NOT PRESENT on this page: Weaknesses"* rather than
simply not being shown one. An agent that is merely not shown a weakness section
will happily conclude the character has none. One that is told the section is
missing cannot.

![The devil's advocate refusing the premise of the question. Asked how Superman
can counter Iron Man's weakness, it reports that the MCU page has no Weaknesses
section at all, marks every weakness a reader might recall — Kryptonite, magic,
EMP, hacking — as UNVERIFIED, and states plainly that answering anyway "would be
fabrication". It also catches that the only "Iron Man" on a Superman-compatible
DC wiki is an unrelated thief, not Tony
Stark.](docs/devils-advocate.png)

**Canon is tagged, and conflicts are preserved.** Every claim carries `[COMICS]`,
`[FILM]` or `[BOTH]`. Where continuities disagree the council reports both
readings rather than averaging them — the disagreement is usually the most
useful thing on screen, because it tells you exactly which claims an opponent
can contest.

**`[UNVERIFIED]` marks what will not survive a challenge.** Inference is allowed;
passing it off as sourced fact is not.

![The coordinator's headline answer, with a COMICS or FILM chip attached to
every individual claim and an UNVERIFIED chip on the one inference. Under "Where
this breaks" it names which agents disagree and why — the canon-keeper says act
on the armour's structural limits, the vulnerability-mapper and devil's advocate
say no strategy is defensible until the missing section is retrieved, the
crisis-forecaster reframes the risk entirely — instead of averaging them into a
single confident recommendation. The recommendation then lists three courses of
action, each with its cost stated.](docs/coordinator-headline.png)

**No flattery.** Agents are forbidden from opening with praise, and every answer
must fill a heading called **Where this breaks** — which may never be empty and
may never be filled with agreement. Cards in the UI open on that heading rather
than on the finding, because it is the part a delegate most needs and is least
likely to seek out.

![Three agent cards side by side, each collapsed to show only its "Where this
breaks" section rather than its finding, with the seconds that agent took in the
header. All three independently report the same problem from different angles:
the weakness the question assumes does not appear in the retrieved source, so
any plan built on it rests on a gap.](docs/agent-cards.png)

**A grounding audit runs after the answer.** It extracts every proper noun in the
output and checks it against the fetched text, flagging names that appear in the
answer but nowhere in the source. It is a screen, not a verdict — it cannot
judge truth, only show where invention typically surfaces.

In testing against Doctor Doom, the council correctly identified that DC's
"Doctor Doom (Earth-Two)" is an unrelated jewel smuggler rather than merging it
with Victor von Doom, reported the MCU page's missing Weaknesses section as an
absence rather than inventing content, and distinguished currently-listed
weaknesses from ones the wiki files under "Former Weaknesses" — then warned that
relying on the latter would be contestable.

---

## How the repository is laid out

```
agents/          the agent directives — plain markdown, loaded at runtime
                 (see agents/README.md; the most reusable part of this project)

src/wiki/        fetching: title resolution, HTML→text, section extraction, cache
src/council/     the orchestration: router, three-stage run, history
src/agents/      prompt loading and source-text assembly  (code, not prompts)
src/providers/   OpenAI-compatible model providers, failure classification, warm-up
src/settings/    settings and API-key storage, model catalog
src/main/        Electron main process and IPC
src/renderer/    setup, settings and committee screens
src/cli/         terminal entry points

test/            offline test suites — no network, no API cost
tools/           diagnostics that make REAL model calls and cost credits
scripts/         build steps
```

Two names are worth disambiguating up front: **`agents/`** holds the prompts,
while **`src/agents/`** is the code that loads and assembles them. And
**`src/council/`** is the orchestration layer — "council" is this project's own
word for the group of agents that answer one question together.

---

## Installing

Download the build for your platform from the [Releases](../../releases) page.
Both are **unsigned**, so both complain on first launch.

### Windows

Run the `.exe`. SmartScreen shows *"Windows protected your PC"* — click
**More info**, then **Run anyway**.

### macOS

Take **`-arm64.dmg`** for Apple Silicon (M1 and later) or **`-x64.dmg`** for an
Intel Mac. The wrong one fails to launch without a useful message.

Drag the app to Applications, then run this once:

```sh
xattr -cr "/Applications/MUN Advisory Council.app"
```

Without it Gatekeeper usually reports the app **"is damaged and can't be
opened"**, which is misleading — nothing is damaged, it simply carries a
quarantine flag and has no signature to check. **Right-click → Open does not
clear this one.** Removing the quarantine attribute does.

---

## Getting an NVIDIA API key

The app needs a key for an OpenAI-compatible model provider. NVIDIA's free tier
is the default.

> **NVIDIA issues API keys per model, from that model's own page.**
> A key created from your account or profile section **will not work**. This is
> poorly documented and is the single most common way to lose an hour here.

1. Create a free account at [build.nvidia.com](https://build.nvidia.com/).
   Phone verification is required.
2. Open the page for the model you intend to use — the default is
   `deepseek-ai/deepseek-v4-pro-0813`.
3. Click **Get API Key** *on that model's page*.
4. Paste the key into the app's setup screen. It starts with `nvapi-`.
5. Enter the model name exactly as it appears on that page.

The app cannot detect which model a key is scoped to, so it asks you to type it.
That is the normal path, not a fallback.

Keys are stored per user, encrypted with the OS keystore where available
(DPAPI on Windows, Keychain on macOS), and never leave your machine:

| | |
|---|---|
| Windows | `%APPDATA%\MUN Advisory Council\settings.json` |
| macOS | `~/Library/Application Support/MUN Advisory Council/settings.json` |

The renderer can ask the main process to check, save or remove a key. There is
no IPC path that returns one. A backup copy is kept alongside the settings file,
so an interrupted write cannot cost you the key.

---

## Architecture

### Three stages, and why the shape is fixed

```
   ┌──────────┐      ┌──────────────────────────────┐      ┌──────────────┐
   │  Router  │ ───▶ │   Agents (parallel wave)     │ ───▶ │ Coordinator  │
   └──────────┘      │  canon-keeper                │      └──────────────┘
                     │  vulnerability-mapper        │
   decides which     │  crisis-forecaster           │      reads everyone
   agents wake,      │  alliance-strategist         │      and surfaces
   or none at all    │  devils-advocate             │      disagreement
                     └──────────────────────────────┘
```

**The router must go first.** Nothing can start until it decides which agents
wake — or that none should. It returns one of five outcomes: `greeting`, `help`,
`off_topic`, `unclear`, or `proceed`. Only `proceed` costs anything.

**The coordinator must go last.** Its entire job is reading every other agent's
output and naming where they diverge, so it cannot begin before they finish.

**Everything in between runs concurrently.** All five other agents fire at once,
so the middle stage costs one agent's time rather than five.

That leaves **three sequential waits, which sets a floor on latency**. Each wave
pays a fresh model cold start, so the total cannot drop below roughly three
model calls in series no matter how much parallelism is added. Collapsing an
earlier four-stage design into three took a measured run from 1043s to 509s.

The router's constraints are **enforced in code, not trusted to the prompt**: at
least three agents, `devils-advocate` and `coordinator` always included, unknown
agent names dropped, and unparseable output treated as `unclear` rather than
"proceed with nobody". Whatever code had to override is shown to you — the
router advises, it does not rule — and any agent it skipped can be woken by hand.

![The question box and the router's decision. Below the question, the app states
up front that a full council takes roughly 8-9 minutes and why. The Council panel
then lists which agents the router woke and the one-line focus it assigned each
of them, and offers a button to wake the one agent it chose to skip — so the
routing is visible and reversible rather than
hidden.](docs/question-and-router.png)

### Agent directives are editable markdown

Every agent's instructions live as plain markdown in [`agents/`](agents/) and are
**loaded at runtime, not compiled in**:

```
agents/
  shared-rules.md          prepended to every agent; the never-invent and
                           canon-tagging rules live here
  router.md                triage and agent selection
  canon-keeper.md          extracts facts from raw wiki text
  vulnerability-mapper.md  maps weaknesses to who can exploit them
  crisis-forecaster.md     predicts what the chair will introduce
  alliance-strategist.md   reads the table as a network of interests
  devils-advocate.md       attacks the delegate's plan
  coordinator.md           writes the headline answer
  user-guide.md            answers "how do I use this"
```

Edit one and the next question uses it. No rebuild, no reinstall. In a packaged
build they ship alongside the app rather than inside the archive, so they stay
editable there too. Tuning these is the main lever the app has.

**[`agents/README.md`](agents/README.md)** documents the format: how a prompt is
assembled, the shared contract every agent inherits, and how to edit or add one.

## Running from source

Requires Node 22.6+ (24 recommended).

```sh
npm install     # downloads Electron, roughly 100 MB
npm start
```

**You will need an NVIDIA API key to get an answer out of it.** The app opens
its setup screen on first launch and walks you through getting one — see
[Getting an NVIDIA API key](#getting-an-nvidia-api-key) above, in particular
the part about keys being issued per model. Without a key the app runs, the
wiki fetching works, and the council refuses to answer.

### Scripts

Everything under `test/` is free and offline. Everything under `tools/` spends
real API credits.

| Command | Cost | What it does |
|---|---|---|
| `npm test` | free | Every offline suite: settings durability plus four Electron smoke suites |
| `npm run test:durability` | free | Settings write path, corruption and recovery |
| `npm run typecheck` | free | `tsc --noEmit` |
| `npm run wiki -- "Doctor Doom"` | free | Fetch layer only — hits the wikis, never a model |
| `npm start` | free to launch | Runs the app; asking a question costs model calls |
| `npm run doctor` | **partly paid** | Connection and catalog checks are free; key and model verification each cost a call |
| `npm run tool:agent` | **paid** | One agent, raw output plus grounding audit (~2-4 min) |
| `npm run tool:council` | **paid** | A full council run (~9 min, 7 calls) |
| `npm run tool:diagnose` | **paid** | Key and model probes against the stored profile |
| `npm run tool:verify` | **paid** | Full end-to-end verification (~20-40 min, 20+ calls) |
| `npm run dist:win` | free | Portable `.exe` — must run on Windows |
| `npm run dist:mac` | free | `.dmg` arm64 + x64 — must run on macOS |

Every file in `tools/` opens with a warning banner stating its approximate cost.
Nothing there is needed to build, test or contribute.

`.github/workflows/release.yml` builds both platforms on a `v*` tag push.
electron-builder cannot cross-compile a macOS dmg from Windows, so each runner
builds its own.

---

## Limits

**A question takes roughly 3–9 minutes.** Not because the app is slow — the
model cold-starts on essentially every call. Measured against deepseek-v4-pro:
116.5s cold, and 124.1s on an immediate second call, so the instance is torn
down between requests rather than staying warm. The app fires a throwaway
completion at launch to move some of that cost off your first question, and
shows per-stage progress with a live second counter so a long wait reads as work
rather than a hang.

**Quality is bounded by what the wikis contain.** If a page has no Weaknesses
section, no amount of prompting produces one. The app is explicit about this
rather than papering over it, but "explicit about the gap" is still a gap.

**Three agents read raw source rather than the canon-keeper's audited
extraction.** The original design had every downstream claim trace back to one
audited extraction. Because cold-start latency dominates over prompt size,
`devils-advocate`, `crisis-forecaster` and `alliance-strategist` now read their
own lean source slices so they can run in the same parallel wave. The
coordinator still reads canon-keeper's actual output, so the final synthesis
keeps that property — individual agent cards no longer do.

**The macOS build has never been run.** The dmg target, the CI workflow and the
Gatekeeper instructions are written from documented platform behaviour on a
Windows machine. No Mac has executed this. The Keychain code path is likewise
unexercised — the fallback logic is platform-agnostic and asks
`isEncryptionAvailable()` before trusting it, but Keychain has never actually
been the codec in a real run.

**Other rough edges:** key entry covers NVIDIA only (Gemini and OpenRouter work
as fallbacks but need a `.env`); verifying a key costs one completion against
the rate limit; there is no app icon; the settings screen is hand-rolled CSS.

---

## Notes on fetching

Fandom does not behave the way the MediaWiki documentation suggests, and three
of these produce a confidently wrong answer rather than an error.

**`prop=extracts` does not exist there.** Fandom does not install the
TextExtracts extension, so the documented text-extraction endpoint returns
HTTP 200 with a valid-looking page object, no extract, and the problem reported
only in a `warnings` field — reading as "this character has no article" rather
than "this API is not here". Article text comes from `action=parse&prop=text`,
reduced to plain text locally.

**Search fuzzy-matches instead of failing.** Asking the DC Extended Universe wiki
for "Doctor Doom" returns "Babrius Aesop" as its top hit. Candidates are scored
for relevance, and a wiki with no real match reports the gap.

**Aliases resolve to disambiguation pages.** "Doctor Doom" is a disambiguation
page; the article is "Victor von Doom (Earth-616)". The two share one word, so
no string similarity connects them — the app follows the disambiguation
template's own primary-article pointer instead.

**Namespace 0 is not just characters.** Asking Marvel for "Batman" surfaces the
crossover issue "Batman/Spider-Man Vol 1 1". Results must be filed under a
"Characters" category to be accepted.

**Key validation cannot use the models endpoint.** NVIDIA's `GET /v1/models` is
unauthenticated and returns the full catalog with no credentials at all, so a
200 proves nothing about a key. Keys are verified with a real one-token
completion, and a 404 naming the account is reported as "your key works, this
model is not enabled for it" rather than as a bad key.

---

## License

Licensed under the **GNU Affero General Public License v3.0 or later**. See
[LICENSE](LICENSE) for the full text.

AGPL was chosen deliberately: if you modify this and run it as a network
service, you must publish your changes. It cannot be taken closed-source or
turned into a proprietary product.

Wiki content fetched at runtime belongs to its respective wikis and contributors
and is licensed separately, generally under CC-BY-SA. This project is not
affiliated with NVIDIA, Fandom, Marvel or DC.
