# User guide

The app answers "how do I use this" questions from this file. Keep it accurate — it is
reference text, not decoration.

## What this tool does

It is a preparation aid for a Marvel vs DC crisis committee. A council of six specialists reads
wiki source material and analyses your situation from six angles. It does not decide for you.

## Getting started

1. Add your own character in the character panel. The app fetches their pages from the comic
   and film wikis.
2. Add the other characters at the table as you learn who they are.
3. Ask a question.

## Adding characters mid-session

When someone unexpected joins the committee, type their name into the character panel. Their
pages are fetched immediately and the council can use them from the next question onward. This
is the main reason the tool fetches live rather than shipping a fixed library.

## Asking good questions

Specific questions get specific answers. Compare:

- Weak: "Is Superman strong?"
- Strong: "Which characters currently at the table can access Kryptonite, and what would it
  cost them?"
- Strong: "Doctor Strange just joined. What changes for me?"
- Strong: "Here is my draft directive. Where does it break?"

Presenting a draft plan is the highest-value use of the tool. That is when the devil's advocate
does its real work.

## The council

- **Canon Keeper** — extracts facts from the fetched pages. Nothing else in the system is
  allowed to invent, and this agent is the reason why.
- **Vulnerability Mapper** — matches weaknesses to who at the table can actually reach them.
- **Crisis Forecaster** — three scenarios per question: likely, bad, catastrophic.
- **Alliance Strategist** — who to court, and the price of each alignment.
- **Devil's Advocate** — attacks your plan. Always runs. Minimum three break points.
- **Coordinator** — writes the headline answer and surfaces the council's own disagreements.

Not every agent runs on every question. The router picks who is relevant, and shows you why.
You can wake a skipped agent manually.

## Reading the markers

- `[COMICS]` — comic continuity
- `[FILM]` — film continuity
- `[BOTH]` — holds in both
- `[UNVERIFIED]` — not supported by the fetched source

Treat `[UNVERIFIED]` claims as unusable in committee. They will not survive a challenge.

Where the two canons conflict, the council reports both. Knowing which version of a fact an
opponent is relying on is often decisive.

## Settings

API keys, provider order, model choice, per-agent model override, and output language all live
in the settings drawer. If answers feel shallow, try a different model — model quality varies
considerably and the catalogue changes.

## Limits

- The council knows only what has been fetched. Unloaded characters are blind spots.
- Free-tier providers rate-limit. If requests fail, wait a minute or switch provider.
- This is preparation support. Most conferences prohibit device use during committee, and your
  own judgement is what is being assessed.
