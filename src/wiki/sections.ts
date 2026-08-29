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

/**
 * Section-level extraction.
 *
 * A full Doctor Doom article is ~93k characters, almost all of it publication
 * history. Only two agents receive raw wiki text, and they need different
 * slices of it, so the text is cut per agent rather than per page.
 *
 * The rule that matters: a requested section that is not on the page is
 * reported as an explicit gap. Quietly returning four sections when five were
 * asked for would let an agent treat "no weaknesses listed" as "no weaknesses",
 * which is exactly the inference this app exists to prevent.
 */

export interface Section {
  readonly level: number;
  readonly title: string;
  /** Body text including every nested subsection. */
  readonly body: string;
}

const HEADING = /^(#{2,6}) (.+)$/;

/** Split an extract into sections, each carrying its nested subsections. */
export function parseSections(extract: string): Section[] {
  const lines = extract.split("\n");
  const heads: Array<{ level: number; title: string; line: number }> = [];

  lines.forEach((line, i) => {
    const match = HEADING.exec(line);
    if (match) heads.push({ level: match[1]!.length, title: match[2]!.trim(), line: i });
  });

  return heads.map((head, i) => {
    // A section runs until the next heading at the same level or shallower.
    let end = lines.length;
    for (let j = i + 1; j < heads.length; j += 1) {
      if (heads[j]!.level <= head.level) {
        end = heads[j]!.line;
        break;
      }
    }
    return {
      level: head.level,
      title: head.title,
      body: lines.slice(head.line + 1, end).join("\n").trim(),
    };
  });
}

export interface SectionSpec {
  /** Name reported to the agent and to the delegate. */
  readonly name: string;
  /**
   * Budget held back for this section while earlier ones are filled.
   *
   * Without it the fill order alone decides everything: Doctor Doom's
   * Paraphernalia runs to 8k characters and would consume the entire remaining
   * budget, dropping History completely. Reserving keeps every requested
   * section represented, which matters more than any one being complete.
   */
  readonly minChars?: number;
  /**
   * Headings that satisfy this request, best first. The four wikis disagree:
   * Marvel comics has "Weaknesses" under "Attributes", the film wikis use
   * "Biography" where comics use "History", and DC merges "Powers and
   * Abilities" into one heading.
   */
  readonly headings: readonly string[];
}

export interface SelectedSection {
  readonly name: string;
  /** The heading actually matched, which may differ from the requested name. */
  readonly matched: string;
  readonly text: string;
  readonly originalChars: number;
  readonly truncated: boolean;
}

export interface SectionSelection {
  readonly text: string;
  readonly included: readonly SelectedSection[];
  /** Requested sections with no matching heading on this page. */
  readonly missing: readonly string[];
  readonly totalChars: number;
}

function normalizeHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function findSection(sections: readonly Section[], headings: readonly string[]): Section | undefined {
  for (const wanted of headings) {
    const target = normalizeHeading(wanted);
    // Shallowest match wins: "Powers and Abilities" (h2) carries the "Powers"
    // and "Abilities" subsections with it, which a deeper match would lose.
    const matches = sections
      .filter((s) => normalizeHeading(s.title) === target && s.body.trim() !== "")
      .sort((a, b) => a.level - b.level);
    if (matches[0]) return matches[0];
  }
  return undefined;
}

/**
 * Cut an extract down to the sections an agent asked for, within a budget.
 *
 * Sections are filled in the order given, so a profile should list its
 * highest-value sections first — the last one absorbs whatever budget is left
 * and is the one that gets truncated.
 */
export function selectSections(
  extract: string,
  specs: readonly SectionSpec[],
  maxChars: number,
): SectionSelection {
  const sections = parseSections(extract);
  const included: SelectedSection[] = [];
  const missing: string[] = [];
  let used = 0;

  // Resolve every requested section first, so reserves are only held for
  // sections that actually exist on this page.
  const resolved = specs.map((spec) => ({ spec, found: findSection(sections, spec.headings) }));
  for (const { spec, found } of resolved) {
    if (!found) missing.push(spec.name);
  }

  for (let i = 0; i < resolved.length; i += 1) {
    const { spec, found } = resolved[i]!;
    if (!found) continue;

    const full = `${"#".repeat(found.level)} ${found.title}\n${found.body}`.trim();

    // Hold back what later sections asked to reserve, so this one cannot take
    // the whole remaining budget.
    const reservedForLater = resolved
      .slice(i + 1)
      .reduce((sum, r) => sum + (r.found ? Math.min(r.spec.minChars ?? 0, r.found.body.length) : 0), 0);

    const remaining = maxChars - used - reservedForLater;
    if (remaining <= 0) {
      // Budget gone before this section was reached. That is a gap in what the
      // agent sees, so it is reported as one rather than dropped in silence.
      missing.push(`${spec.name} (no budget left)`);
      continue;
    }

    const truncated = full.length > remaining;
    const text = truncated ? `${full.slice(0, remaining).trimEnd()}\n[... truncated]` : full;
    used += text.length;
    included.push({
      name: spec.name,
      matched: found.title,
      text,
      originalChars: full.length,
      truncated,
    });
  }

  return { text: included.map((s) => s.text).join("\n\n"), included, missing, totalChars: used };
}

/**
 * The per-agent slices. Only the two agents that receive raw wiki text appear
 * here; everything else works from the canon-keeper's structured output.
 */
export const SECTION_PROFILES: Record<string, readonly SectionSpec[]> = {
  "canon-keeper": [
    { name: "Powers", headings: ["Powers", "Powers and Abilities"], minChars: 3_000 },
    { name: "Abilities", headings: ["Abilities", "Powers and Abilities", "Skills"], minChars: 2_000 },
    // Weaknesses is the section this whole app exists to surface. It is also
    // usually the shortest, so without a floor it loses every contest with
    // Powers and silently disappears — the one outcome that must never happen.
    {
      name: "Weaknesses",
      headings: ["Weaknesses", "Weakness", "Limitations", "Vulnerabilities"],
      minChars: 4_000,
    },
    {
      name: "Paraphernalia",
      headings: ["Paraphernalia", "Equipment", "Weapons", "Other Equipment"],
      minChars: 2_000,
    },
    // History is the largest section by far and the least dense in facts, so it
    // is filled last — but it still gets a guaranteed floor rather than being
    // dropped whenever Paraphernalia happens to be long.
    { name: "History", headings: ["History", "Biography"], minChars: 8_000 },
  ],
  "vulnerability-mapper": [
    { name: "Weaknesses", headings: ["Weaknesses", "Weakness", "Limitations", "Vulnerabilities"] },
    { name: "Powers", headings: ["Powers", "Powers and Abilities"] },
  ],
  // These three used to read only canon-keeper's synthesis, which forced them
  // to wait for it to finish before they could even start. Cold-start latency
  // on this deployment (~2min per call, roughly flat regardless of prompt
  // size) turns that into one whole extra sequential wave — a much bigger
  // cost here than the token overhead of a direct source-text slice. Each gets
  // its own lean, role-tuned excerpt instead, so it can run in the same
  // parallel batch as canon-keeper.
  "devils-advocate": [
    { name: "Weaknesses", headings: ["Weaknesses", "Weakness", "Limitations", "Vulnerabilities"] },
    { name: "Powers", headings: ["Powers", "Powers and Abilities"] },
  ],
  "crisis-forecaster": [
    { name: "Weaknesses", headings: ["Weaknesses", "Weakness", "Limitations", "Vulnerabilities"] },
    { name: "History", headings: ["History", "Biography"] },
  ],
  "alliance-strategist": [
    { name: "History", headings: ["History", "Biography"] },
    { name: "Powers", headings: ["Powers", "Powers and Abilities"] },
  ],
};

/** Per-agent character budget for one character's page. */
export const SECTION_BUDGETS: Record<string, number> = {
  "canon-keeper": 24_000,
  // Each of these carries one page per character at the table, so their
  // per-page budget is much tighter than the keeper's.
  "vulnerability-mapper": 6_000,
  "devils-advocate": 6_000,
  "crisis-forecaster": 6_000,
  "alliance-strategist": 6_000,
};
