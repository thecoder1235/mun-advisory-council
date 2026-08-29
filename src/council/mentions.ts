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
 * Spotting characters the delegate asked about but never loaded.
 *
 * The council can only reason from fetched wiki text. If the question names
 * someone who is not at the table, the honest answer is "no source for them" —
 * but an agent handed a question about Thor with no Thor page is exactly the
 * situation where remembered comic trivia leaks in. Naming the omission in the
 * prompt is what stops that.
 *
 * Deliberately conservative: a missed mention costs nothing (the agents are
 * still told to work only from source), while a false positive would tell the
 * delegate their loaded character is missing. So this only flags capitalised
 * words that are clearly not sentence-initial grammar.
 */

const COMMON = new Set([
  "the", "this", "that", "these", "those", "a", "an", "and", "or", "but", "if",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "i", "my", "me", "we", "our", "us", "you", "your", "he", "she", "they", "them",
  "his", "her", "their", "its", "it", "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "can", "could", "would", "should", "may", "might", "will",
  "at", "in", "on", "of", "for", "to", "from", "with", "without", "by", "as",
  "table", "committee", "chair", "crisis", "delegate", "council", "plan",
  "weakness", "weaknesses", "strength", "strengths", "here", "there", "now",
  "comics", "film", "canon", "marvel", "dc", "unverified", "both",
  // Sentence-initial words are no longer skipped structurally, so the common
  // ways a delegate opens a question have to be listed here instead.
  "add", "give", "tell", "show", "find", "list", "help", "make", "check",
  "assume", "suppose", "consider", "explain", "compare", "against", "before",
  "after", "during", "should", "would", "must", "let", "note", "also", "then",
  "next", "first", "last", "another", "other", "others", "someone", "everyone",
  "nobody", "anyone", "something", "nothing", "everything", "please", "thanks",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Names in the question that do not correspond to any loaded character.
 *
 * `loaded` should include both what the delegate typed and the titles those
 * queries actually resolved to, so "Doom" matches a table holding
 * "Victor von Doom (Earth-616)".
 */
export function findUnloadedMentions(
  question: string,
  loaded: readonly string[],
): string[] {
  const haystack = loaded.map(normalize).join(" | ");

  // Capitalised runs, including at the start of a sentence. Skipping
  // sentence-initial words would be safer against false positives, but it
  // rejects "Thor just joined the table" — the single most likely way a
  // delegate names someone new. The stopword list carries the weight instead,
  // and a stray false positive only adds a "not loaded" note, while a false
  // negative is what lets remembered trivia through.
  const candidates = new Set<string>();
  const pattern = /\b([A-Z][a-z'’-]{2,}(?:[ ][A-Z][a-z'’-]{2,}){0,2})/g;

  for (const match of question.matchAll(pattern)) {
    const raw = match[1]!.trim();
    const norm = normalize(raw);
    if (norm === "" || COMMON.has(norm)) continue;
    // Every word being a stopword means this is a phrase, not a name.
    if (norm.split(" ").every((w) => COMMON.has(w))) continue;
    candidates.add(raw);
  }

  return [...candidates].filter((name) => {
    const norm = normalize(name);
    if (haystack.includes(norm)) return false;
    // A single token that appears inside any loaded name counts as loaded:
    // "Doom" against "Doctor Doom".
    return !norm.split(" ").some((word) => word.length > 3 && haystack.includes(word));
  });
}
