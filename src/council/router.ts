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

import { complete, type CompletionResult, type ProviderConfig } from "../providers/index.ts";
import { buildDirective } from "../agents/loader.ts";

/**
 * The router decides which agents wake, and whether any do.
 *
 * Its constraints are enforced here in code rather than trusted to the prompt.
 * A model that quietly drops the devil's advocate produces a council that only
 * agrees with itself, and the delegate has no way to notice that happened.
 */

export type RouterOutcome = "greeting" | "help" | "off_topic" | "unclear" | "proceed";

export const ALL_AGENTS = [
  "canon-keeper",
  "vulnerability-mapper",
  "crisis-forecaster",
  "alliance-strategist",
  "devils-advocate",
  "coordinator",
] as const;

export type AgentName = (typeof ALL_AGENTS)[number];

/** Agents the router may never remove, per the brief. */
const MANDATORY: readonly AgentName[] = ["devils-advocate", "coordinator"];
const MIN_AGENTS = 3;

export interface RoutedAgent {
  readonly name: AgentName;
  /** One line appended to the agent's own directive. Never replaces it. */
  readonly focus: string | null;
}

export interface RouterDecision {
  readonly outcome: RouterOutcome;
  /** Short reply for non-proceed outcomes. */
  readonly reply: string | null;
  readonly agents: readonly RoutedAgent[];
  /** What the router returned before code enforcement, for the UI to show. */
  readonly rawAgents: readonly string[];
  /** Constraints code had to apply, so the delegate can see the router was overruled. */
  readonly corrections: readonly string[];
  readonly completion: CompletionResult;
}

function isAgentName(value: string): value is AgentName {
  return (ALL_AGENTS as readonly string[]).includes(value);
}

/** Pull the JSON object out of a reply that may be fenced or padded with prose. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost brace pair.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export interface RouteOptions {
  readonly question: string;
  /** Characters currently loaded, so the router knows what the table holds. */
  readonly characters: readonly string[];
  readonly model?: string;
  readonly apiKeys?: Readonly<Record<string, string>>;
  readonly providers?: readonly ProviderConfig[];
  readonly onAttempt?: (note: string) => void;
}

export async function route(opts: RouteOptions): Promise<RouterDecision> {
  const directive = await buildDirective("router");

  const table =
    opts.characters.length === 0
      ? "No characters are loaded yet."
      : `Characters loaded: ${opts.characters.join(", ")}.`;

  const completion = await complete(
    {
      messages: [
        { role: "system", content: directive },
        {
          role: "user",
          content: `${table}\n\nMessage from the delegate:\n${opts.question}\n\nReturn JSON only.`,
        },
      ],
      ...(opts.model === undefined ? {} : { model: opts.model }),
      temperature: 0,
      maxTokens: 700,
    },
    {
      ...(opts.apiKeys === undefined ? {} : { apiKeys: opts.apiKeys }),
      ...(opts.providers === undefined ? {} : { providers: opts.providers }),
      ...(opts.onAttempt === undefined ? {} : { onAttempt: opts.onAttempt }),
    },
  );

  const parsed = extractJson(completion.text) as
    | { outcome?: string; reply?: string | null; agents?: Array<{ name?: string; focus?: string | null }> }
    | null;

  const corrections: string[] = [];

  // Unparseable output must not silently become "proceed with nobody". Asking
  // the delegate to rephrase is the safe failure.
  if (parsed === null || typeof parsed.outcome !== "string") {
    return {
      outcome: "unclear",
      reply: "I could not read that reliably. Could you rephrase the question?",
      agents: [],
      rawAgents: [],
      corrections: ["router returned unparseable output; treated as unclear"],
      completion,
    };
  }

  const outcome: RouterOutcome = (
    ["greeting", "help", "off_topic", "unclear", "proceed"] as const
  ).includes(parsed.outcome as RouterOutcome)
    ? (parsed.outcome as RouterOutcome)
    : "unclear";

  if (outcome !== "proceed") {
    return {
      outcome,
      reply: typeof parsed.reply === "string" ? parsed.reply : null,
      agents: [],
      rawAgents: [],
      corrections,
      completion,
    };
  }

  const rawAgents = (parsed.agents ?? []).flatMap((a) =>
    typeof a?.name === "string" ? [a.name] : [],
  );

  const chosen = new Map<AgentName, string | null>();
  for (const entry of parsed.agents ?? []) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!isAgentName(name)) {
      if (name !== "") corrections.push(`ignored unknown agent "${name}"`);
      continue;
    }
    const focus = typeof entry.focus === "string" && entry.focus.trim() !== "" ? entry.focus.trim() : null;
    chosen.set(name, focus);
  }

  // Enforce the mandatory agents. The router advises; it does not rule.
  for (const required of MANDATORY) {
    if (!chosen.has(required)) {
      chosen.set(required, null);
      corrections.push(`${required} is mandatory and was added back`);
    }
  }

  // Enforce the minimum. canon-keeper first, since everything else builds on it.
  const fillOrder: AgentName[] = ["canon-keeper", "vulnerability-mapper", "crisis-forecaster", "alliance-strategist"];
  for (const candidate of fillOrder) {
    if (chosen.size >= MIN_AGENTS) break;
    if (!chosen.has(candidate)) {
      chosen.set(candidate, null);
      corrections.push(`added ${candidate} to reach the ${MIN_AGENTS}-agent minimum`);
    }
  }

  // Stable order: canon-keeper leads, coordinator always last.
  const order: AgentName[] = [
    "canon-keeper",
    "vulnerability-mapper",
    "crisis-forecaster",
    "alliance-strategist",
    "devils-advocate",
    "coordinator",
  ];
  const agents: RoutedAgent[] = order
    .filter((name) => chosen.has(name))
    .map((name) => ({ name, focus: chosen.get(name) ?? null }));

  return { outcome: "proceed", reply: null, agents, rawAgents, corrections, completion };
}
