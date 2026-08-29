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
import type { CharacterDossier } from "../wiki/types.ts";
import { buildDirective } from "./loader.ts";
import { buildSourceBlock, type SourceBlock } from "./source-text.ts";

export interface RunAgentOptions {
  readonly agent: string;
  readonly question: string;
  readonly dossiers: readonly CharacterDossier[];
  /** The router's one-line note, appended to the agent's own directive. */
  readonly focusNote?: string;
  /** Per-agent model override; falls back to the global setting, then the provider default. */
  readonly model?: string;
  readonly outputLanguage?: string;
  readonly onAttempt?: (note: string) => void;
  /** Provider id -> key, resolved from settings then the environment. */
  readonly apiKeys?: Readonly<Record<string, string>>;
  /** Provider chain to try, in fallback order. */
  readonly providers?: readonly ProviderConfig[];
}

export interface AgentRun {
  readonly agent: string;
  readonly directive: string;
  readonly source: SourceBlock;
  readonly userMessage: string;
  readonly completion: CompletionResult;
}

/**
 * Directives are always written in English; only the answer changes language.
 * Keeping the instruction here rather than in the prompt files is what lets the
 * language be a setting without editing every agent on disk.
 */
function languageInstruction(language: string): string {
  return language.toLowerCase().startsWith("en")
    ? ""
    : `\n\nWrite your response in ${language}. Keep the four headings, the [UNVERIFIED] marker, and the [COMICS]/[FILM]/[BOTH] tags exactly as written — do not translate them.`;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentRun> {
  const directive = await buildDirective(opts.agent, opts.focusNote);
  const source = buildSourceBlock(opts.agent, opts.dossiers);

  const userMessage = [
    source.text,
    "",
    "# QUESTION",
    "",
    opts.question,
    "",
    "# REMINDER",
    "",
    "Answer only from the source text above. Anything not directly supported by it must carry [UNVERIFIED]. Tag every factual claim [COMICS], [FILM], or [BOTH]. Use the four standard headings.",
  ].join("\n");

  const completion = await complete(
    {
      messages: [
        { role: "system", content: directive + languageInstruction(opts.outputLanguage ?? "English") },
        { role: "user", content: userMessage },
      ],
      ...(opts.model === undefined ? {} : { model: opts.model }),
      temperature: 0.2,
      maxTokens: 2048,
    },
    {
      ...(opts.apiKeys === undefined ? {} : { apiKeys: opts.apiKeys }),
      ...(opts.providers === undefined ? {} : { providers: opts.providers }),
      ...(opts.onAttempt === undefined ? {} : { onAttempt: opts.onAttempt }),
    },
  );

  return { agent: opts.agent, directive, source, userMessage, completion };
}
