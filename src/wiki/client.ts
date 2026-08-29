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
 * Thin MediaWiki client for Fandom.
 *
 * Note on the endpoint: the brief specifies `prop=extracts&explaintext=1`, but
 * Fandom does not install the TextExtracts extension. That request succeeds
 * with HTTP 200, returns the page object with no extract, and reports the
 * problem only in a `warnings` field — so it reads as "page has no content"
 * rather than "this API does not exist here". Article prose therefore comes
 * from `action=parse&prop=text`, which is rendered HTML that html-to-text.ts
 * reduces to plain text.
 */

const USER_AGENT =
  "MUN-Advisory-Council/0.1 (Model UN committee prep; contact: local user)";

export interface FetchOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url: string, opts: FetchOptions = {}): Promise<unknown> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as unknown;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const retryable =
        err instanceof Error &&
        (err.name === "TimeoutError" ||
          err.name === "AbortError" ||
          err.message.includes("fetch failed"));
      if (!retryable) throw err;
    }
  }
  throw new Error(`request failed after ${retries + 1} attempts: ${lastError}`);
}

function apiUrl(wiki: WikiSource, params: Record<string, string>): string {
  const url = new URL(`https://${wiki.host}/api.php`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export function articleUrl(wiki: WikiSource, title: string): string {
  return `https://${wiki.host}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** Candidate titles for an informally typed name. Relevance is judged in resolve.ts. */
export async function searchTitles(
  wiki: WikiSource,
  query: string,
  opts: FetchOptions = {},
): Promise<readonly string[]> {
  const url = apiUrl(wiki, {
    action: "opensearch",
    search: query,
    limit: "10",
    namespace: "0",
    format: "json",
  });
  const raw = await getJson(url, opts);
  if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) return [];
  return (raw[1] as unknown[]).filter((t): t is string => typeof t === "string");
}

export interface ParsedPage {
  readonly status: "ok";
  readonly title: string;
  readonly pageId: number;
  /** Rendered HTML, not yet reduced to text. */
  readonly html: string;
  readonly categories: readonly string[];
  /** Outgoing article links, used to walk off a disambiguation page. */
  readonly links: readonly string[];
}

export type ParseResult = ParsedPage | { readonly status: "missing"; readonly title: string };

export async function parsePage(
  wiki: WikiSource,
  title: string,
  opts: FetchOptions = {},
): Promise<ParseResult> {
  const url = apiUrl(wiki, {
    action: "parse",
    page: title,
    prop: "text|categories|links",
    redirects: "1",
    format: "json",
    formatversion: "2",
  });

  const raw = (await getJson(url, opts)) as {
    error?: { code?: string; info?: string };
    parse?: {
      title?: string;
      pageid?: number;
      text?: string;
      categories?: Array<{ category?: string }>;
      links?: Array<{ title?: string; ns?: number; exists?: boolean }>;
    };
  };

  // A page that does not exist comes back as an API error, not an empty parse.
  if (raw.error) {
    if (raw.error.code === "missingtitle" || raw.error.code === "nosuchpageid") {
      return { status: "missing", title };
    }
    throw new Error(`${raw.error.code ?? "api_error"}: ${raw.error.info ?? "unknown"}`);
  }
  if (!raw.parse) return { status: "missing", title };

  return {
    status: "ok",
    title: raw.parse.title ?? title,
    pageId: raw.parse.pageid ?? -1,
    html: raw.parse.text ?? "",
    categories: (raw.parse.categories ?? []).flatMap((c) =>
      c.category === undefined ? [] : [c.category.replace(/_/g, " ")]),
    links: (raw.parse.links ?? []).flatMap((l) =>
      l.ns === 0 && l.exists !== false && l.title !== undefined ? [l.title] : []),
  };
}

/**
 * Raw wikitext for a page. Used only on disambiguation pages, whose template
 * names the primary article directly — far more reliable than guessing from
 * the rendered link list.
 */
export async function fetchWikitext(
  wiki: WikiSource,
  title: string,
  opts: FetchOptions = {},
): Promise<string | null> {
  const url = apiUrl(wiki, {
    action: "parse",
    page: title,
    prop: "wikitext",
    redirects: "1",
    format: "json",
    formatversion: "2",
  });
  const raw = (await getJson(url, opts)) as {
    error?: unknown;
    parse?: { wikitext?: string };
  };
  if (raw.error || !raw.parse?.wikitext) return null;
  return raw.parse.wikitext;
}
