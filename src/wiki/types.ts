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

import type { Canon, Publisher, WikiSource } from "./wikis.ts";

/** How the query became a title. Shown in the UI so the delegate can audit it. */
export interface TitleResolution {
  /** What the user typed. */
  readonly query: string;
  /** Titles opensearch offered, before relevance filtering. */
  readonly candidates: readonly string[];
  /** The candidate chosen, before any disambiguation hop. */
  readonly picked: string;
  /** Set when `picked` turned out to be a disambiguation page we walked through. */
  readonly viaDisambiguation?: string;
  /**
   * Other incarnations this query could legitimately have resolved to, best
   * first. Continuity preference is a default, not a verdict: a delegate
   * playing an alternate-universe incarnation has to be able to switch, so the
   * character panel shows these and `fetchCharacter` accepts an override.
   */
  readonly alternatives: readonly string[];
  readonly resolvedAt: string;
}

/** A page that was actually retrieved, with its canon attached. */
export interface WikiPage {
  readonly wikiId: string;
  readonly host: string;
  readonly canon: Canon;
  readonly publisher: Publisher;
  readonly query: string;
  readonly resolvedTitle: string;
  readonly pageId: number;
  readonly url: string;
  /** Plain text reduced from the rendered article HTML. */
  readonly extract: string;
  readonly resolution: TitleResolution;
  /** ISO timestamp of the network fetch, not of the cache read. */
  readonly fetchedAt: string;
}

/**
 * Why a wiki produced nothing. Kept distinct from `error` on purpose: "this
 * character does not exist in this canon" is a fact worth showing the delegate,
 * while "the request failed" is not.
 */
export type MissReason =
  /** opensearch returned nothing at all. */
  | "no_search_match"
  /** opensearch returned hits, but none actually match the query. */
  | "no_relevant_match"
  /** The chosen title turned out not to exist. */
  | "page_missing"
  /** A disambiguation page we could not walk through to a real article. */
  | "unresolved_disambiguation"
  /** Hits existed, but they are comic issues or galleries, not character pages. */
  | "not_a_character"
  /** The page exists but carries no usable prose. */
  | "empty_extract";

export type WikiResult =
  | {
      readonly status: "found";
      readonly wiki: WikiSource;
      readonly page: WikiPage;
      readonly fromCache: boolean;
    }
  | {
      readonly status: "missing";
      readonly wiki: WikiSource;
      readonly query: string;
      readonly reason: MissReason;
      readonly detail: string;
      /** What opensearch offered, so the delegate can retype with a better name. */
      readonly candidates: readonly string[];
    }
  | {
      readonly status: "error";
      readonly wiki: WikiSource;
      readonly query: string;
      readonly error: string;
    };

export interface CharacterDossier {
  readonly query: string;
  readonly startedAt: string;
  readonly results: readonly WikiResult[];
}

export function foundPages(dossier: CharacterDossier): readonly WikiPage[] {
  return dossier.results.flatMap((r) => (r.status === "found" ? [r.page] : []));
}

export function missingWikis(dossier: CharacterDossier): readonly WikiSource[] {
  return dossier.results.flatMap((r) => (r.status === "missing" ? [r.wiki] : []));
}

export function erroredWikis(dossier: CharacterDossier): readonly WikiSource[] {
  return dossier.results.flatMap((r) => (r.status === "error" ? [r.wiki] : []));
}
