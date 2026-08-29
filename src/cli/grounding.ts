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
 * A mechanical check on whether an answer stayed inside its source text.
 *
 * This is a screen, not a verdict. It cannot tell whether a claim is true — it
 * can only tell you which proper nouns in the answer never appear in the text
 * the model was given. Those are where invention shows up first: a named
 * artifact, a named opponent, a named storyline the page never mentioned.
 * Everything it flags still needs a human to look at the page.
 */

const HEADINGS = ["Finding", "Where this breaks", "Recommendation", "If I'm wrong"];

const FLATTERY =
  /^\s*(great|good|excellent|strong|nice|solid|smart|interesting)\b|^\s*you(?:'re| are)\s+right\b/i;

/** Words that start a sentence or are common enough to be noise, not evidence. */
const COMMON = new Set([
  "the", "this", "that", "these", "those", "a", "an", "and", "or", "but", "if", "then",
  "he", "she", "they", "it", "his", "her", "their", "its", "you", "your", "we", "our",
  "in", "on", "at", "to", "for", "of", "with", "without", "from", "by", "as", "is", "was",
  "are", "were", "be", "been", "not", "no", "none", "any", "all", "both", "each",
  "finding", "where", "recommendation", "wrong", "breaks", "unverified", "comics", "film",
  "both", "source", "sources", "text", "page", "pages", "wiki", "section", "sections",
  "note", "notes", "however", "although", "because", "there", "here", "when", "while",
  "his", "hers", "theirs", "who", "what", "which", "why", "how", "do", "does", "did",
  "can", "could", "would", "should", "may", "might", "must", "will", "shall",
]);

/** Lines that are structure, not prose: the four standard headings and any bold-only label. */
function isStructuralLine(line: string): boolean {
  const bare = line.replace(/[*_`#>-]/g, "").trim();
  if (bare === "") return true;
  if (/^(finding|where this breaks|recommendation|if i'm wrong|if i am wrong)\b/i.test(bare)) return true;
  // A line that is entirely a bold label, e.g. "**Ego** [COMICS]:" prefix rows
  // are prose and must stay; a standalone "**Recommendation**" is not.
  return /^\*\*[^*]+\*\*\s*$/.test(line.trim());
}

function properNouns(text: string): string[] {
  // Drop heading lines before anything else. Splitting on them mid-sentence was
  // producing phantom "names" like "Recommendation\n\nBuild" and "If I'm",
  // which read as inventions in the report when nothing had been invented.
  const body = text
    .split("\n")
    .filter((line) => !isStructuralLine(line))
    .join("\n");

  // Strip the markers we add ourselves so they are not counted as names.
  const cleaned = body
    .replace(/\[(UNVERIFIED|COMICS|FILM|BOTH)\]/g, " ")
    .replace(/[*_`#>]/g, " ");

  const found = new Set<string>();
  // Capitalised runs: "Reed Richards", "Infinity Gauntlet", "Latveria".
  const pattern = /\b([A-Z][a-z'’-]{1,}(?:\s+(?:of|the|von|van|de|da)\s+)?(?:\s+[A-Z][a-z'’-]{1,}){0,3})/g;
  for (const match of cleaned.matchAll(pattern)) {
    // A trailing connector with nothing after it is a sentence fragment
    // ("Build the ..."), not part of a name.
    const raw = match[1]!.trim().replace(/ (?:of|the|von|van|de|da)$/i, "");
    if (raw.length < 4) continue;
    if (COMMON.has(raw.toLowerCase())) continue;

    // A single capitalised word starting a sentence is grammar, not a name.
    // Requiring it to appear mid-sentence somewhere keeps real one-word
    // entities ("Latveria", "Mephisto") while dropping "Build" and "Taking".
    if (!raw.includes(" ")) {
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`[a-z,;:]\\s+${escaped}\\b`).test(cleaned)) continue;
    }
    found.add(raw);
  }
  return [...found];
}

/** Words worth checking against the source; connectors and short words are noise. */
function significantWords(name: string): string[] {
  return name
    .split(/[\s'’-]+/)
    .filter((w) => w.length > 3 && !COMMON.has(w.toLowerCase()));
}

/** Which lines carry an [UNVERIFIED] marker, so flagged names can be excused. */
function unverifiedLines(text: string): string[] {
  return text.split(/\n|(?<=\.)\s+/).filter((line) => line.includes("[UNVERIFIED]"));
}

export interface GroundingAudit {
  readonly hasAllHeadings: boolean;
  readonly missingHeadings: readonly string[];
  readonly canonTagCount: number;
  readonly canonTagBreakdown: string;
  readonly unverifiedCount: number;
  readonly hasFlattery: boolean;
  /** Proper nouns in the answer absent from the source text. */
  readonly unsupportedNames: readonly string[];
  /** Of those, the ones the model itself flagged [UNVERIFIED]. */
  readonly unverifiedNames: ReadonlySet<string>;
}

export function auditGrounding(answer: string, source: string): GroundingAudit {
  const missingHeadings = HEADINGS.filter(
    (h) => !new RegExp(`\\*{0,2}${h.replace(/'/g, "['’]")}\\*{0,2}`, "i").test(answer),
  );

  const comics = (answer.match(/\[COMICS\]/g) ?? []).length;
  const film = (answer.match(/\[FILM\]/g) ?? []).length;
  const both = (answer.match(/\[BOTH\]/g) ?? []).length;

  const sourceLower = source.toLowerCase();

  // Judge a name by its words, not by exact phrase match. "Taking Pandora's
  // Box" is a sentence fragment whose every word is in the source; "Cosmic Cube
  // of Zarathos" contains a word that is not. Only the second is evidence of
  // invention, and phrase matching cannot tell them apart.
  const flagged = properNouns(answer).filter((name) => {
    if (sourceLower.includes(name.toLowerCase())) return false;
    const words = significantWords(name);
    if (words.length === 0) return false;
    return words.some((w) => !sourceLower.includes(w.toLowerCase()));
  });

  const unverifiedText = unverifiedLines(answer).join("\n").toLowerCase();
  const unverifiedNames = new Set(flagged.filter((n) => unverifiedText.includes(n.toLowerCase())));

  return {
    hasAllHeadings: missingHeadings.length === 0,
    missingHeadings,
    canonTagCount: comics + film + both,
    canonTagBreakdown: `${comics} COMICS, ${film} FILM, ${both} BOTH`,
    unverifiedCount: (answer.match(/\[UNVERIFIED\]/g) ?? []).length,
    hasFlattery: FLATTERY.test(answer),
    unsupportedNames: flagged.sort((a, b) => a.localeCompare(b)),
    unverifiedNames,
  };
}
