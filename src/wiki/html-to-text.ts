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
 * Fandom has no TextExtracts extension, so `prop=extracts` does not exist there
 * and the only route to article prose is the rendered HTML from `action=parse`.
 * These pages run to hundreds of KB, most of it infoboxes, galleries, navboxes
 * and appearance tables — none of which is usable source text for an agent.
 *
 * Tag scanning is done by hand rather than with regex: Fandom nests tables in
 * tables and figures in asides, and a non-greedy regex pairs an outer opening
 * tag with an inner closing one. That mispairing deletes across the real
 * boundary and leaks infobox chrome back into the prose.
 */

/** Elements whose entire contents are chrome, not article prose. */
const DROP_ELEMENTS = new Set([
  "script",
  "style",
  "table",
  "figure",
  "figcaption",
  "aside",
  "sup",
  "audio",
  "video",
  "nav",
]);

/** Void elements never have a closing tag, so they must not open a depth. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Fandom/MediaWiki wrapper classes that hold navigation and metadata. */
const DROP_CLASS_PATTERN =
  /(infobox|navbox|noprint|toc|mw-editsection|reference|gallery|notice|hatnote|dablink|mw-empty-elt|(^|[\s"])(pi|va|nav)-)/i;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', times: "x", deg: "°",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

interface Tag {
  readonly name: string;
  readonly kind: "open" | "close" | "self";
  /** Index of the '<'. */
  readonly start: number;
  /** Index just past the '>'. */
  readonly end: number;
  readonly raw: string;
}

/**
 * Walk the markup yielding tags. Attribute values are skipped with quote
 * tracking so a '>' inside an attribute cannot end a tag early.
 */
function* tags(html: string): Generator<Tag> {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return;

    // Comments and doctype/CDATA are not tags; skip past them wholesale.
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      const close = html.indexOf(">", lt);
      i = close === -1 ? html.length : close + 1;
      continue;
    }

    let cursor = lt + 1;
    const isClose = html[cursor] === "/";
    if (isClose) cursor += 1;

    const nameStart = cursor;
    while (cursor < html.length && /[a-zA-Z0-9]/.test(html[cursor] ?? "")) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();
    if (name === "") {
      i = lt + 1;
      continue;
    }

    // Scan to the '>' that actually closes this tag.
    let quote: string | null = null;
    while (cursor < html.length) {
      const ch = html[cursor];
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      cursor += 1;
    }
    if (cursor >= html.length) return;

    const end = cursor + 1;
    const raw = html.slice(lt, end);
    const selfClosing = html[cursor - 1] === "/" || VOID_ELEMENTS.has(name);

    yield {
      name,
      kind: isClose ? "close" : selfClosing ? "self" : "open",
      start: lt,
      end,
      raw,
    };
    i = end;
  }
}

function classOf(raw: string): string {
  const match = /class\s*=\s*("([^"]*)"|'([^']*)')/i.exec(raw);
  return match?.[2] ?? match?.[3] ?? "";
}

/**
 * Remove every element the predicate rejects, contents included. Tracks depth
 * so an unbalanced or stray closing tag cannot swallow a neighbouring element.
 */
function dropElements(html: string, shouldDrop: (tag: Tag) => boolean): string {
  let out = "";
  let cursor = 0;
  // Stack of open element names, so depth is tracked per nesting level.
  const stack: string[] = [];
  let dropAt = -1;
  let dropDepth = -1;

  for (const tag of tags(html)) {
    if (tag.kind === "self") {
      if (dropAt === -1 && shouldDrop(tag)) {
        out += html.slice(cursor, tag.start);
        cursor = tag.end;
      }
      continue;
    }

    if (tag.kind === "open") {
      if (dropAt === -1 && shouldDrop(tag)) {
        dropAt = tag.start;
        dropDepth = stack.length;
      }
      stack.push(tag.name);
      continue;
    }

    // Closing tag: unwind to the matching open, tolerating unclosed children.
    const matchIndex = stack.lastIndexOf(tag.name);
    if (matchIndex === -1) continue; // stray close, nothing open
    stack.length = matchIndex;

    if (dropAt !== -1 && stack.length <= dropDepth) {
      out += html.slice(cursor, dropAt);
      cursor = tag.end;
      dropAt = -1;
      dropDepth = -1;
    }
  }

  // An element left unclosed at end of document: drop it and everything after.
  if (dropAt !== -1) return out + html.slice(cursor, dropAt);
  return out + html.slice(cursor);
}

export function htmlToText(html: string): string {
  let text = dropElements(
    html,
    (tag) => DROP_ELEMENTS.has(tag.name) || DROP_CLASS_PATTERN.test(classOf(tag.raw)),
  );

  // Structure worth preserving: headings become labelled lines, list items get
  // a bullet. The canon-keeper leans on section names to tell a power from a
  // weakness, so flattening these away would cost real signal.
  // Heading level is load-bearing, not decoration: on Marvel pages "Powers",
  // "Abilities" and "Weaknesses" are h3 nested under an h2 "Attributes", and a
  // section cannot be extracted with its subsections without knowing depth.
  text = text
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) =>
      `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|tr|dd|dt|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    // Citation markers survive tag stripping as bare "[ 267 ]" and add nothing.
    .map((line) => line.replace(/\[\s*\d+\s*\]/g, "").replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^- *$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Marvel and DC character pages carry long trailing sections — appearance
 * indexes, trivia, image galleries — that add tokens without adding facts.
 */
const TRAILING_SECTIONS =
  /^#{2,6} (appearances|images|external links|see also|references|footnotes|links and references|recommended reading|gallery|media|navigation)\b/i;

export function trimTrailingSections(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex((line) => TRAILING_SECTIONS.test(line));
  return cut === -1 ? text : lines.slice(0, cut).join("\n").trim();
}
