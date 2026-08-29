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

import {
  SECTION_BUDGETS,
  SECTION_PROFILES,
  selectSections,
  type SectionSelection,
} from "../wiki/sections.ts";
import type { CharacterDossier, WikiResult } from "../wiki/types.ts";

/**
 * Assemble the source text block an agent receives.
 *
 * Everything here is built around making absence legible. A section that is not
 * on the page, a wiki that returned nothing, a section dropped for budget —
 * each is stated in the block itself. An agent that is merely *not shown* a
 * weakness section will happily conclude the character has no weaknesses; an
 * agent told "this page has no Weaknesses section" cannot.
 */

/**
 * A gap, structured rather than pre-formatted.
 *
 * Several agents now build their own source block from the same pages, so the
 * same gap is discovered several times over with slightly different wording.
 * Keeping the parts separate lets the council collapse them to one entry per
 * page instead of listing near-duplicates that bury the real gaps.
 */
export interface SourceGap {
  readonly character: string;
  readonly canon: string;
  readonly wiki: string;
  readonly kind: "no-page-anywhere" | "no-page" | "fetch-failed" | "missing-sections" | "shortened";
  /** Section names, for the kinds that carry them. */
  readonly sections?: readonly string[];
  readonly detail?: string;
}

export interface SourceBlock {
  readonly text: string;
  /** Every gap named in the block, for the UI to surface alongside the answer. */
  readonly gaps: readonly SourceGap[];
  readonly totalChars: number;
}

function describeMiss(result: Extract<WikiResult, { status: "missing" }>): string {
  const reasons: Record<string, string> = {
    no_search_match: "no article on this wiki matches the name",
    no_relevant_match: "the wiki's search returned only unrelated pages",
    page_missing: "the article the search pointed at does not exist",
    unresolved_disambiguation: "the name resolves to a disambiguation page with no usable article",
    not_a_character: "the best match is not a character page",
    empty_extract: "the article exists but has no usable prose",
  };
  return reasons[result.reason] ?? result.reason;
}

export function buildSourceBlock(
  agent: string,
  dossiers: readonly CharacterDossier[],
): SourceBlock {
  const specs = SECTION_PROFILES[agent];
  const budget = SECTION_BUDGETS[agent];
  if (!specs || budget === undefined) {
    throw new Error(`no section profile for agent "${agent}" — it does not receive raw wiki text`);
  }

  const lines: string[] = ["# SOURCE TEXT", ""];
  const gaps: SourceGap[] = [];

  for (const dossier of dossiers) {
    lines.push(`## CHARACTER: ${dossier.query}`, "");

    const found = dossier.results.filter((r) => r.status === "found");

    /**
     * Which publisher this character actually belongs to.
     *
     * Superman is not on the Marvel wikis and Iron Man is not on the DC ones.
     * Those misses are the expected answer to a question nobody asked, not gaps
     * in the delegate's preparation — and reporting them buries the real ones.
     *
     * Presence alone is too weak a test, because the crossover pages defeat it:
     * DC hosts an Amalgam "Iron Man" and a wholly unrelated Earth-Two "Doctor
     * Doom", so a single stub is enough to make the entire opposite publisher
     * look native. Weight by how much text each publisher actually yielded
     * instead — a real home page runs to tens of thousands of characters while
     * a crossover stub runs to one or two thousand.
     */
    const charsByPublisher = new Map<string, number>();
    for (const r of found) {
      if (r.status !== "found") continue;
      charsByPublisher.set(
        r.page.publisher,
        (charsByPublisher.get(r.page.publisher) ?? 0) + r.page.extract.length,
      );
    }
    const dominantChars = Math.max(0, ...charsByPublisher.values());
    /** A publisher holding under a fifth of the text is a crossover, not a home. */
    const isMinorPublisher = (result: WikiResult): boolean =>
      dominantChars > 0 &&
      (charsByPublisher.get(result.wiki.publisher) ?? 0) < dominantChars * 0.2;

    if (found.length === 0) {
      lines.push(
        `NO SOURCE TEXT WAS RETRIEVED FOR THIS CHARACTER FROM ANY WIKI.`,
        `You have no information about them. Say so.`,
        "",
      );
      gaps.push({
        character: dossier.query,
        canon: "",
        wiki: "",
        kind: "no-page-anywhere",
      });
    }

    for (const result of dossier.results) {
      if (result.status === "found") {
        const { page } = result;
        const selection: SectionSelection = selectSections(page.extract, specs, budget);

        lines.push(
          `### SOURCE — [${page.canon}] ${result.wiki.label} — "${page.resolvedTitle}"`,
          `URL: ${page.url}`,
          `Sections supplied: ${selection.included.map((s) => s.name).join(", ") || "none"}`,
        );

        const truncated = selection.included.filter((s) => s.truncated);
        if (truncated.length > 0) {
          const note = truncated
            .map((s) => `${s.name} (shown partially, ${s.text.length} of ${s.originalChars} characters)`)
            .join("; ");
          lines.push(`Sections shortened for length: ${note}`);
          if (!isMinorPublisher(result)) {
            gaps.push({
              character: dossier.query,
              canon: page.canon,
              wiki: result.wiki.label,
              kind: "shortened",
              sections: truncated.map((s) => s.name),
            });
          }
        }

        if (selection.missing.length > 0) {
          lines.push(
            `Sections NOT PRESENT on this page: ${selection.missing.join(", ")}.`,
            `There is no data for those sections. Do not supply any from memory.`,
          );
          if (!isMinorPublisher(result)) {
            gaps.push({
              character: dossier.query,
              canon: page.canon,
              wiki: result.wiki.label,
              kind: "missing-sections",
              sections: selection.missing,
            });
          }
        }

        lines.push("", selection.text, "");
        continue;
      }

      // A miss on the other publisher's wikis is expected. Say nothing at all:
      // the agent does not need to be told Superman is absent from Marvel.
      if (isMinorPublisher(result)) continue;

      if (result.status === "missing") {
        lines.push(
          `### NO PAGE — [${result.wiki.canon}] ${result.wiki.label}`,
          `Reason: ${describeMiss(result)}.`,
          `Nothing was retrieved from this wiki. You have no facts from this canon for this character.`,
          "",
        );
        gaps.push({
          character: dossier.query,
          canon: result.wiki.canon,
          wiki: result.wiki.label,
          kind: "no-page",
          detail: describeMiss(result),
        });
        continue;
      }

      lines.push(
        `### FETCH FAILED — [${result.wiki.canon}] ${result.wiki.label}`,
        `The request errored (${result.error}), so this canon is unchecked rather than empty.`,
        "",
      );
      gaps.push({
        character: dossier.query,
        canon: result.wiki.canon,
        wiki: result.wiki.label,
        kind: "fetch-failed",
      });
    }
  }

  const text = lines.join("\n").trim();
  return { text, gaps, totalChars: text.length };
}

/**
 * Collapse gaps found independently by several agents into one line per page.
 *
 * Four agents each build a source block from the same pages, so without this
 * the same page contributes four near-identical entries — and the section
 * kinds ("shortened Powers", "shortened History") arrive separately even
 * within one agent.
 */
export function formatGaps(all: readonly SourceGap[]): string[] {
  const merged = new Map<string, { gap: SourceGap; sections: Set<string> }>();

  for (const gap of all) {
    const key = `${gap.character}|${gap.canon}|${gap.wiki}|${gap.kind}`;
    const existing = merged.get(key);
    if (existing) {
      for (const section of gap.sections ?? []) existing.sections.add(section);
    } else {
      merged.set(key, { gap, sections: new Set(gap.sections ?? []) });
    }
  }

  return [...merged.values()].map(({ gap, sections }) => {
    const where = gap.canon === "" ? gap.character : `${gap.character} [${gap.canon}] ${gap.wiki}`;
    const list = [...sections].join(", ");
    switch (gap.kind) {
      case "no-page-anywhere":
        return `${gap.character}: no page on any of the four wikis`;
      case "no-page":
        return `${where}: ${gap.detail ?? "no page"}`;
      case "fetch-failed":
        return `${where}: fetch failed`;
      case "missing-sections":
        return `${where}: no ${list} section`;
      case "shortened":
        return `${where}: shortened ${list}`;
    }
  });
}
