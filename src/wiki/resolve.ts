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

import type { WikiSource } from "./wikis.ts";

/**
 * Turning what the delegate typed into the right article.
 *
 * `action=opensearch` alone is not enough on these wikis, in two distinct ways:
 *
 * 1. It fuzzy-matches rather than failing. Asking the DC Extended Universe wiki
 *    for "Doctor Doom" returns "Babrius Aesop" as the top hit. Taking hit zero
 *    on faith hands the agents a page for an unrelated character and presents
 *    it as sourced fact — the exact failure this app exists to prevent.
 *
 * 2. The top hit for a major character is usually a disambiguation page, since
 *    Marvel and DC file each incarnation under a reality suffix. "Doctor Doom"
 *    is a disambiguation page; the article is "Victor von Doom (Earth-616)".
 *
 * So: score candidates for relevance, reject the whole wiki if nothing scores,
 * and prefer each wiki's main continuity when several incarnations match.
 */

/** The continuity each wiki treats as its default, best first. */
const PREFERRED_REALITIES: Record<string, readonly string[]> = {
  "marvel-comics": ["earth-616"],
  "dc-comics": ["prime earth", "new earth"],
  "marvel-film": ["earth-199999"],
  "dc-film": [],
};

const STOPWORDS = new Set(["the", "a", "an", "of", "and"]);

/**
 * Qualifiers that mark a page as a stand-in for the character rather than the
 * character: "Doctor Doom (Android) (Earth-616)" is a Doombot built by the Mad
 * Thinker, and it out-matches the real Victor von Doom on title similarity
 * alone. Briefing a delegate from the decoy's page would be indefensible in
 * committee.
 */
const DECOY_QUALIFIERS =
  /^(android|robot|doombot|clone|duplicate|imposter|impostor|life model decoy|lmd|skrull|hologram|projection|statue|corpse|earth-\d+ )/i;

/** Strip the "(Earth-616)" style suffixes wikis use to separate continuities. */
export function stripQualifier(title: string): string {
  let out = title;
  // Titles carry more than one: "Doctor Doom (Android) (Earth-616)".
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/\s*\([^()]*\)\s*$/, "").trim();
    if (next === out || next === "") break;
    out = next;
  }
  return out;
}

/** Every trailing parenthetical group, outermost last. */
export function qualifiers(title: string): string[] {
  const found: string[] = [];
  let rest = title;
  for (let i = 0; i < 4; i += 1) {
    const match = /\(([^()]*)\)\s*$/.exec(rest);
    if (!match) break;
    found.unshift((match[1] ?? "").trim().toLowerCase());
    rest = rest.slice(0, match.index).trim();
  }
  return found;
}

export function qualifierOf(title: string): string {
  return qualifiers(title).at(-1) ?? "";
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[\s-]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * How well a candidate title answers the query, 0-100. Zero means "do not use
 * this page" — it is better to tell the delegate a wiki has nothing than to
 * hand the council a page about someone else.
 */
export function scoreTitle(query: string, title: string, wiki: WikiSource): number {
  const qNorm = normalize(query);
  const bare = stripQualifier(title);
  const tNorm = normalize(bare);

  const qTokens = tokenize(query);
  const tTokens = new Set(tokenize(bare));
  if (qTokens.length === 0) return 0;

  let score: number;
  if (qNorm === tNorm) {
    score = 100;
  } else if (tNorm.startsWith(`${qNorm} `) || tNorm.endsWith(` ${qNorm}`)) {
    score = 80;
  } else if (qTokens.every((t) => tTokens.has(t))) {
    // Every word the delegate typed appears in the title: "Doom" -> "Victor von
    // Doom" is a real match, while "Doom" -> "Doomsday" is not, because
    // tokens are compared whole rather than as substrings.
    score = 65;
  } else {
    return 0;
  }

  const marks = qualifiers(title);

  // A title carrying a qualifier is one incarnation among many; prefer the
  // wiki's main continuity, and never let an obscure reality outrank it.
  const reality = marks.at(-1) ?? "";
  if (reality !== "") {
    const preferred = PREFERRED_REALITIES[wiki.id] ?? [];
    const rank = preferred.indexOf(reality);
    if (rank !== -1) score += 15 - rank * 2;
    else score -= 20;
  }

  // A second qualifier means the page is a variant of a variant — an android,
  // a clone, an alternate-timeline echo. Push those below the plain article.
  if (marks.some((m) => DECOY_QUALIFIERS.test(m))) score -= 60;
  else if (marks.length > 1) score -= 25;

  return Math.max(0, score);
}

export interface RankedTitle {
  readonly title: string;
  readonly score: number;
}

export function rankTitles(
  query: string,
  titles: readonly string[],
  wiki: WikiSource,
): RankedTitle[] {
  return titles
    .filter((title) => looksLikeArticleTitle(title))
    .map((title) => ({ title, score: scoreTitle(query, title, wiki) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.title.length - b.title.length);
}

/** MediaWiki files disambiguation pages under a category naming them as such. */
export function isDisambiguation(categories: readonly string[]): boolean {
  return categories.some((c) => /disambig/i.test(c));
}

/**
 * The primary article a disambiguation page points at.
 *
 * This matters more than it looks. Delegates type an alias — "Doctor Doom" —
 * but articles are filed under the character's name, "Victor von Doom
 * (Earth-616)". No amount of string similarity bridges that gap; the two share
 * one word. The disambiguation template is the wiki's own alias-to-article
 * mapping, so read it rather than guessing.
 */
export function mainFromDisambiguation(wikitext: string): string | null {
  // Marvel's template calls the parameter `main`, DC's calls it `MainPage`.
  const match = /\|\s*main(?:page)?\s*=\s*([^\n|}]+)/i.exec(wikitext);
  const title = match?.[1]?.trim().replace(/^\[\[|\]\]$/g, "").trim();
  if (!title) return null;
  // Some pages point at a section or carry a display override; keep the page.
  return title.split("#")[0]?.split("|")[0]?.trim() || null;
}

/**
 * Namespace 0 holds far more than characters: comic issues, volumes, galleries
 * and appearance indexes all live there. Asking Marvel for "Batman" returns the
 * crossover issue "Batman/Spider-Man Vol 1 1" as its best hit.
 */
const NON_ARTICLE_TITLE = /(\bVol\.? ?\d+|\/|\bComic Books\b|\bGallery\b|\bAppearances\b|\bImages\b|\bQuotes\b|\bRelationships\b|\(disambiguation\))/i;

export function looksLikeArticleTitle(title: string): boolean {
  return !NON_ARTICLE_TITLE.test(title);
}

/**
 * All four wikis file character pages under a category containing "Characters"
 * — "Characters", "Male Characters", "Suicide Squad Characters". Anything
 * without one is a comic issue, a team, a location or an event, and briefing a
 * delegate from it would be worse than reporting the gap.
 */
export function looksLikeCharacter(categories: readonly string[]): boolean {
  return categories.some((c) => /characters?\b/i.test(c));
}
