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

import { buildDirective } from "../agents/loader.ts";
import { buildSourceBlock, formatGaps, type SourceGap } from "../agents/source-text.ts";
import { complete, type ProviderConfig } from "../providers/index.ts";
import { SECTION_PROFILES } from "../wiki/sections.ts";
import type { CharacterDossier } from "../wiki/types.ts";
import { findUnloadedMentions } from "./mentions.ts";
import { route, type AgentName, type RouterDecision, type RoutedAgent } from "./router.ts";

/**
 * The council: router first, then every non-coordinator agent in one parallel
 * wave, then the coordinator.
 *
 * This deviates from the brief's original sequencing (canon-keeper runs alone
 * first, "it feeds the others"). That design keeps requests small and lets
 * every downstream claim trace back to one audited extraction. It also costs
 * one entire extra sequential wave — and on this deployment, cold-start
 * provisioning dominates: a single-token probe and a full multi-thousand-token
 * completion took the same order of magnitude (~2min) to first respond, so
 * request size barely matters while wave count matters enormously. Measured:
 * a 4-wave run (router, canon-keeper, parallel-middle, coordinator) took
 * 1043s; the agents most exposed to that ordering — devils-advocate,
 * crisis-forecaster, alliance-strategist — no longer wait on canon-keeper's
 * synthesis to start. Each reads its own lean raw-text slice instead (see
 * `wiki/sections.ts`), so it can run in the same wave as canon-keeper.
 *
 * The coordinator still runs alone, last: it is the one agent that
 * structurally cannot start before the others finish, since its whole job is
 * reading everyone else's output and surfacing where it disagrees.
 */

export interface AgentResult {
  readonly agent: AgentName;
  readonly focus: string | null;
  readonly text: string;
  readonly model: string;
  readonly provider: string;
  readonly elapsedMs: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  /** Set instead of text when this agent failed; the others still stand. */
  readonly error?: string;
}

export type CouncilEvent =
  | { readonly type: "router"; readonly decision: Omit<RouterDecision, "completion"> }
  | { readonly type: "agent-start"; readonly agent: AgentName; readonly focus: string | null }
  | { readonly type: "agent-done"; readonly result: AgentResult }
  | { readonly type: "note"; readonly text: string };

export interface CouncilRequest {
  readonly question: string;
  readonly dossiers: readonly CharacterDossier[];
  readonly apiKeys?: Readonly<Record<string, string>>;
  readonly providers?: readonly ProviderConfig[];
  /** Agent name -> model id, already resolved from settings. */
  readonly models?: Readonly<Record<string, string | undefined>>;
  readonly outputLanguage?: string;
  /** Agents the delegate woke by hand, on top of the router's selection. */
  readonly forceAgents?: readonly AgentName[];
  readonly onEvent?: (event: CouncilEvent) => void;
}

export interface CouncilAnswer {
  readonly question: string;
  /** Agents that failed, so the UI can offer to retry just those. */
  readonly failedAgents?: readonly AgentName[];
  readonly askedAt: string;
  readonly outcome: RouterDecision["outcome"] | "no_characters";
  /** Set for greeting/help/off_topic/unclear, where no agent runs. */
  readonly reply: string | null;
  readonly router: Omit<RouterDecision, "completion"> | null;
  readonly results: readonly AgentResult[];
  /** The coordinator's synthesis, lifted out for the headline slot. */
  readonly headline: string | null;
  readonly gaps: readonly string[];
  readonly characters: readonly string[];
}

function languageInstruction(language: string): string {
  return language.toLowerCase().startsWith("en")
    ? ""
    : `\n\nWrite your response in ${language}. Keep the four headings, the [UNVERIFIED] marker, and the [COMICS]/[FILM]/[BOTH] tags exactly as written — do not translate them.`;
}

const FOUR_HEADING_REMINDER =
  "Use the four standard headings. Anything not directly supported by the material above must carry [UNVERIFIED]. Tag every factual claim [COMICS], [FILM], or [BOTH].";

async function runOne(
  agent: AgentName,
  focus: string | null,
  userMessage: string,
  req: CouncilRequest,
): Promise<AgentResult> {
  const started = Date.now();
  try {
    const directive = await buildDirective(agent, focus ?? undefined);
    const model = req.models?.[agent];

    const completion = await complete(
      {
        messages: [
          {
            role: "system",
            content: directive + languageInstruction(req.outputLanguage ?? "English"),
          },
          { role: "user", content: userMessage },
        ],
        ...(model === undefined ? {} : { model }),
        temperature: 0.2,
        maxTokens: 2048,
      },
      {
        ...(req.apiKeys === undefined ? {} : { apiKeys: req.apiKeys }),
        ...(req.providers === undefined ? {} : { providers: req.providers }),
      },
    );

    return {
      agent,
      focus,
      text: completion.text,
      model: completion.model,
      provider: completion.provider,
      elapsedMs: Date.now() - started,
      ...(completion.promptTokens === undefined ? {} : { promptTokens: completion.promptTokens }),
      ...(completion.completionTokens === undefined
        ? {}
        : { completionTokens: completion.completionTokens }),
    };
  } catch (err) {
    // One agent failing must not take the council down: a partial answer with
    // the gap named is more use than nothing.
    return {
      agent,
      focus,
      text: "",
      model: req.models?.[agent] ?? "",
      provider: "",
      elapsedMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runCouncil(req: CouncilRequest): Promise<CouncilAnswer> {
  const askedAt = new Date().toISOString();
  const characters = req.dossiers.map((d) => d.query);

  // 0. Nothing to reason from. Refuse before spending a single call: an
  //    empty table means every answer would be from memory, which is the one
  //    thing this app exists to prevent.
  if (req.dossiers.length === 0) {
    return {
      question: req.question,
      askedAt,
      outcome: "no_characters",
      reply:
        "Add a character before asking. Start with the character you are playing, then add the " +
        "others at the table. Everything the council says is drawn from their wiki pages, so with " +
        "nobody loaded there is no source to reason from.",
      router: null,
      results: [],
      headline: null,
      gaps: [],
      characters,
    };
  }

  // 1. Route.
  const decision = await route({
    question: req.question,
    characters,
    ...(req.models?.["router"] === undefined ? {} : { model: req.models["router"] }),
    ...(req.apiKeys === undefined ? {} : { apiKeys: req.apiKeys }),
    ...(req.providers === undefined ? {} : { providers: req.providers }),
  });

  const { completion: _routerCompletion, ...routerPublic } = decision;
  req.onEvent?.({ type: "router", decision: routerPublic });

  if (decision.outcome !== "proceed") {
    return {
      question: req.question,
      askedAt,
      outcome: decision.outcome,
      reply: decision.reply,
      router: routerPublic,
      results: [],
      headline: null,
      gaps: [],
      characters,
    };
  }

  // The delegate can wake an agent the router skipped. The router advises.
  const selected: RoutedAgent[] = [...decision.agents];
  for (const forced of req.forceAgents ?? []) {
    if (!selected.some((a) => a.name === forced)) {
      selected.push({ name: forced, focus: null });
      req.onEvent?.({ type: "note", text: `${forced} was woken by hand` });
    }
  }

  // Characters the question names that nobody loaded.
  const loadedNames = req.dossiers.flatMap((d) => [
    d.query,
    ...d.results.flatMap((r) => (r.status === "found" ? [r.page.resolvedTitle] : [])),
  ]);
  const unloaded = findUnloadedMentions(req.question, loadedNames);

  const sourceFor = (agent: AgentName): { text: string; gaps: readonly SourceGap[] } =>
    SECTION_PROFILES[agent] === undefined
      ? { text: "", gaps: [] }
      : buildSourceBlock(agent, req.dossiers);

  // Collected raw and collapsed at the end: several agents build a block from
  // the same pages, so the same gap arrives many times over.
  const gaps: SourceGap[] = [];
  const results: AgentResult[] = [];

  // 2. Every non-coordinator agent in one parallel wave. Each reads its own
  //    raw-text slice directly — nobody blocks on canon-keeper finishing.
  const wave = selected.filter((a) => a.name !== "coordinator");

  const waveResults = await Promise.all(
    wave.map(async (entry) => {
      const source = sourceFor(entry.name);
      gaps.push(...source.gaps);
      req.onEvent?.({ type: "agent-start", agent: entry.name, focus: entry.focus });

      const parts: string[] = [];
      if (unloaded.length > 0) {
        // Named but not at the table. Say so before the source, so the agent
        // treats them as unknown rather than reaching for what it remembers.
        parts.push(
          "# CHARACTERS NAMED BUT NOT LOADED",
          "",
          `The question mentions ${unloaded.join(", ")}, but no wiki page was fetched for them.`,
          "You have no source material about them whatsoever. Do not describe their powers,",
          "weaknesses, history or relationships. Say that they are not loaded and that the",
          "delegate should add them to the table.",
          "",
        );
      }
      if (source.text !== "") {
        parts.push(source.text, "");
      } else {
        parts.push(
          "# NO SOURCE MATERIAL",
          "",
          "No character facts were retrieved for this agent. Say what you cannot determine rather than filling the gap.",
          "",
        );
      }
      parts.push("# QUESTION", "", req.question, "", "# REMINDER", "", FOUR_HEADING_REMINDER);

      const result = await runOne(entry.name, entry.focus, parts.join("\n"), req);
      req.onEvent?.({ type: "agent-done", result });
      return result;
    }),
  );
  results.push(...waveResults);

  const formattedGaps = formatGaps(gaps);

  // 3. Coordinator last, reading everything the council produced — including
  //    canon-keeper's extraction, which now reaches it here rather than being
  //    threaded into every other agent's own prompt.
  const coordinator = selected.find((a) => a.name === "coordinator");
  let headline: string | null = null;
  if (coordinator) {
    req.onEvent?.({ type: "agent-start", agent: "coordinator", focus: coordinator.focus });

    const transcript = results
      .filter((r) => r.error === undefined && r.text.trim() !== "")
      .map((r) => `## ${r.agent}\n\n${r.text}`)
      .join("\n\n---\n\n");

    const failed = results.filter((r) => r.error !== undefined).map((r) => r.agent);
    const message = [
      "# COUNCIL OUTPUT",
      "",
      transcript === "" ? "(no agent produced output)" : transcript,
      "",
      ...(failed.length > 0
        ? [
            "# AGENTS THAT PRODUCED NOTHING",
            "",
            `These agents failed and returned no output: ${failed.join(", ")}.`,
            "Say explicitly in your answer which readings are missing and what that leaves uncovered.",
            "Do not attempt to supply their analysis yourself.",
            "",
          ]
        : []),
      ...(unloaded.length > 0
        ? [
            "# CHARACTERS NAMED BUT NOT LOADED",
            "",
            `${unloaded.join(", ")} — no source was fetched. Say so; do not describe them.`,
            "",
          ]
        : []),
      ...(formattedGaps.length > 0
        ? ["# DECLARED SOURCE GAPS", "", formattedGaps.map((g) => `- ${g}`).join("\n"), ""]
        : []),
      "# QUESTION",
      "",
      req.question,
      "",
      "# REMINDER",
      "",
      "Do not smooth over disagreement between agents — name who said what and why they diverge. Preserve [UNVERIFIED], [COMICS] and [FILM] markers. Lay out options and their costs; do not decide for the delegate.",
    ].join("\n");

    const result = await runOne("coordinator", coordinator.focus, message, req);
    results.push(result);
    headline = result.error === undefined ? result.text : null;
    req.onEvent?.({ type: "agent-done", result });
  }

  return {
    question: req.question,
    askedAt,
    outcome: "proceed",
    reply: null,
    router: routerPublic,
    results,
    headline,
    gaps: formattedGaps,
    characters,
    failedAgents: results.filter((r) => r.error !== undefined).map((r) => r.agent),
  };
}
