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
  readCachedPage,
  readCachedResolution,
  writeCachedPage,
  writeCachedResolution,
} from "./cache.ts";
import {
  articleUrl,
  fetchWikitext,
  parsePage,
  searchTitles,
  type ParsedPage,
} from "./client.ts";
import { htmlToText, trimTrailingSections } from "./html-to-text.ts";
import {
  isDisambiguation,
  looksLikeCharacter,
  mainFromDisambiguation,
  rankTitles,
} from "./resolve.ts";
import type {
  CharacterDossier,
  MissReason,
  TitleResolution,
  WikiPage,
  WikiResult,
} from "./types.ts";
import { WIKIS, type WikiSource } from "./wikis.ts";

export interface DossierOptions {
  /** Ignore the cache and hit the network. The cache is still rewritten. */
  readonly refresh?: boolean;
  /** Delay between wiki starts, so four parallel calls do not arrive as a burst. */
  readonly staggerMs?: number;
  /** Restrict the sweep; defaults to all four wikis. */
  readonly wikis?: readonly WikiSource[];
  /** Fired as each wiki settles, so the UI can stream rather than wait. */
  readonly onResult?: (result: WikiResult) => void;
  /**
   * Force a specific article per wiki id, bypassing title resolution. This is
   * how the character panel switches incarnation when the delegate is playing
   * one the wiki does not treat as primary.
   */
  readonly titleOverrides?: Readonly<Record<string, string>>;
}

const DEFAULT_STAGGER_MS = 250;
/** Below this, an article is a stub or a redirect shell, not usable source text. */
const MIN_USEFUL_EXTRACT = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function missing(
  wiki: WikiSource,
  query: string,
  reason: MissReason,
  detail: string,
  candidates: readonly string[],
): WikiResult {
  return { status: "missing", wiki, query, reason, detail, candidates };
}

/** Disambiguation pages can chain, so the hop is bounded rather than recursive. */
const MAX_DISAMBIGUATION_HOPS = 3;
/** How many opensearch hits to actually open before giving up on a wiki. */
const MAX_CANDIDATES_TRIED = 3;

interface ResolvedArticle {
  readonly parsed: ParsedPage;
  /** The candidate we opened. */
  readonly picked: string;
  /** Set when `picked` was a disambiguation page we walked through. */
  readonly viaDisambiguation?: string;
  /** Other incarnations the delegate could switch to. */
  readonly alternatives: readonly string[];
}

/**
 * Open candidates in order until one is a real character article.
 *
 * Two things stand between a search hit and a usable page. Aliases resolve to
 * disambiguation pages, which have to be walked through. And namespace 0 is
 * full of non-characters — asking Marvel for "Batman" surfaces the crossover
 * issue "Batman/Spider-Man Vol 1 1" ahead of anything else. Falling through to
 * the next candidate handles both without ever guessing.
 */
async function resolveArticle(
  wiki: WikiSource,
  query: string,
  ordered: readonly string[],
): Promise<ResolvedArticle | { reason: MissReason; detail: string }> {
  let lastReason: MissReason = "page_missing";
  let lastDetail = `no candidate on ${wiki.host} resolved to a character page`;

  for (const candidate of ordered.slice(0, MAX_CANDIDATES_TRIED)) {
    let parsed = await parsePage(wiki, candidate);
    if (parsed.status === "missing") {
      lastReason = "page_missing";
      lastDetail = `opensearch offered "${candidate}" but the page does not exist`;
      continue;
    }

    let via: string | undefined;
    let siblings: readonly string[] = [];
    for (let hop = 0; hop < MAX_DISAMBIGUATION_HOPS; hop += 1) {
      if (!isDisambiguation(parsed.categories)) break;

      // The template names the primary article outright. Prefer it: the
      // delegate typed an alias, and no string comparison connects "Doctor
      // Doom" to "Victor von Doom (Earth-616)".
      const wikitext = await fetchWikitext(wiki, parsed.title);
      const declared = wikitext === null ? null : mainFromDisambiguation(wikitext);
      const linked = rankTitles(query, parsed.links, wiki).filter(
        (c) => c.title !== parsed.title && c.title !== via,
      );

      // Everything the disambiguation page offers is a legitimate alternate
      // incarnation of this character, which is exactly the switch list.
      siblings = linked.map((c) => c.title);

      const target = declared ?? linked[0]?.title;
      if (target === undefined || target === parsed.title) break;

      const followed = await parsePage(wiki, target);
      if (followed.status === "missing") break;
      via = target;
      parsed = followed;
    }

    if (isDisambiguation(parsed.categories)) {
      lastReason = "unresolved_disambiguation";
      lastDetail = `"${parsed.title}" is a disambiguation page with no article this app could follow it to`;
      continue;
    }
    if (!looksLikeCharacter(parsed.categories)) {
      lastReason = "not_a_character";
      lastDetail = `"${parsed.title}" is not a character page (it is filed under ${parsed.categories.slice(0, 2).join(", ") || "no usable category"})`;
      continue;
    }

    const alternatives = [...siblings, ...ordered]
      .filter((t) => t !== parsed.title && t !== candidate)
      .filter((t, i, all) => all.indexOf(t) === i)
      .slice(0, 8);

    return via === undefined
      ? { parsed, picked: candidate, alternatives }
      : { parsed, picked: candidate, viaDisambiguation: via, alternatives };
  }

  return { reason: lastReason, detail: lastDetail };
}

async function fetchFromWiki(
  wiki: WikiSource,
  query: string,
  opts: DossierOptions,
): Promise<WikiResult> {
  const refresh = opts.refresh ?? false;

  try {
    // 1. Resolve the informal name to a real title.
    let resolution: TitleResolution | null = null;
    let candidates: readonly string[] = [];

    const override = opts.titleOverrides?.[wiki.id];
    if (override !== undefined) {
      resolution = {
        query,
        candidates: [override],
        picked: override,
        alternatives: [],
        resolvedAt: new Date().toISOString(),
      };
      candidates = [override];
    }

    const cached =
      refresh || override !== undefined ? undefined : await readCachedResolution(wiki, query);
    if (cached) {
      resolution = cached.resolution;
      candidates = cached.candidates;
    } else if (override === undefined) {
      candidates = await searchTitles(wiki, query);
      if (candidates.length === 0) {
        await writeCachedResolution(wiki, { query, resolution: null, candidates: [] });
        return missing(wiki, query, "no_search_match", `no page on ${wiki.host} matches "${query}"`, []);
      }

      const ranked = rankTitles(query, candidates, wiki);
      if (ranked.length === 0) {
        // opensearch fuzzy-matches rather than failing, so unrelated hits are
        // routine. Reporting the gap beats handing the council a wrong page.
        await writeCachedResolution(wiki, { query, resolution: null, candidates });
        return missing(
          wiki,
          query,
          "no_relevant_match",
          `nothing on ${wiki.host} matches "${query}" (closest: ${candidates.slice(0, 3).join(", ")})`,
          candidates,
        );
      }

      resolution = {
        query,
        candidates,
        picked: ranked[0]!.title,
        alternatives: [],
        resolvedAt: new Date().toISOString(),
      };
    }

    if (resolution === null) {
      return missing(
        wiki,
        query,
        candidates.length === 0 ? "no_search_match" : "no_relevant_match",
        `nothing on ${wiki.host} matches "${query}"`,
        candidates,
      );
    }

    // 2. Serve the cached article if we already hold it.
    const finalTitle = resolution.viaDisambiguation ?? resolution.picked;
    if (!refresh) {
      const page = await readCachedPage(wiki, finalTitle);
      if (page) return { status: "found", wiki, page, fromCache: true };
    }

    // 3. Fetch the article, walking off disambiguation pages and past hits that
    //    turn out not to be characters at all.
    const ordered = [
      resolution.picked,
      ...rankTitles(query, candidates, wiki)
        .map((c) => c.title)
        .filter((t) => t !== resolution!.picked),
    ];
    const resolved = await resolveArticle(wiki, query, ordered);
    if ("reason" in resolved) {
      return missing(wiki, query, resolved.reason, resolved.detail, candidates);
    }

    const { parsed } = resolved;
    resolution =
      resolved.viaDisambiguation === undefined
        ? { ...resolution, picked: resolved.picked, alternatives: resolved.alternatives }
        : {
            ...resolution,
            picked: resolved.picked,
            viaDisambiguation: resolved.viaDisambiguation,
            alternatives: resolved.alternatives,
          };

    // An override is the delegate's choice for one lookup, not the answer to
    // "what does this query mean", so it must not overwrite the resolution.
    if (override === undefined) {
      await writeCachedResolution(wiki, { query, resolution, candidates });
    }

    const extract = trimTrailingSections(htmlToText(parsed.html));
    if (extract.length < MIN_USEFUL_EXTRACT) {
      return missing(
        wiki,
        query,
        "empty_extract",
        `"${parsed.title}" exists but has no usable prose (${extract.length} chars)`,
        candidates,
      );
    }

    const page: WikiPage = {
      wikiId: wiki.id,
      host: wiki.host,
      canon: wiki.canon,
      publisher: wiki.publisher,
      query,
      resolvedTitle: parsed.title,
      pageId: parsed.pageId,
      url: articleUrl(wiki, parsed.title),
      extract,
      resolution,
      fetchedAt: new Date().toISOString(),
    };
    await writeCachedPage(wiki, page);
    return { status: "found", wiki, page, fromCache: false };
  } catch (err) {
    return {
      status: "error",
      wiki,
      query,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Sweep every wiki for one character. Never throws for a single wiki failing —
 * a partial dossier with the gaps named is the useful outcome, and the gaps are
 * exactly what the agents must be told about rather than allowed to fill in.
 */
export async function fetchCharacter(
  query: string,
  opts: DossierOptions = {},
): Promise<CharacterDossier> {
  const trimmed = query.trim();
  const wikis = opts.wikis ?? WIKIS;
  const stagger = opts.staggerMs ?? DEFAULT_STAGGER_MS;
  const startedAt = new Date().toISOString();

  const results = await Promise.all(
    wikis.map(async (wiki, i) => {
      if (stagger > 0 && i > 0) await sleep(i * stagger);
      const result = await fetchFromWiki(wiki, trimmed, opts);
      opts.onResult?.(result);
      return result;
    }),
  );

  return { query: trimmed, startedAt, results };
}

export * from "./types.ts";
export * from "./wikis.ts";
export { getCacheRoot, setCacheRoot } from "./cache.ts";
