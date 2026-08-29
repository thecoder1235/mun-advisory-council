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

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { TitleResolution, WikiPage } from "./types.ts";
import type { WikiSource } from "./wikis.ts";

/**
 * The cache is the delegate's growing library. It persists between runs and is
 * never invalidated by time — a wiki page that was true last week is still the
 * page the delegate quoted in committee, and silently swapping it under them
 * would be worse than serving it stale.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/wiki -> project root, and dist/wiki -> project root. Both are two up. */
const PROJECT_ROOT = resolve(HERE, "..", "..");

let cacheRoot = process.env["MUN_CACHE_DIR"]
  ? resolve(process.env["MUN_CACHE_DIR"])
  : join(PROJECT_ROOT, "cache");

/** Electron will point this at app.getPath('userData') once the shell exists. */
export function setCacheRoot(dir: string): void {
  cacheRoot = resolve(dir);
}

export function getCacheRoot(): string {
  return cacheRoot;
}

/**
 * Wiki titles contain characters Windows will not accept in a filename, and
 * differ only by case on a case-insensitive filesystem. Slug for readability,
 * hash suffix for correctness.
 */
function slugify(value: string): string {
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8);
  const slug = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return slug ? `${slug}--${hash}` : hash;
}

function pagePath(wiki: WikiSource, title: string): string {
  return join(cacheRoot, wiki.id, "pages", `${slugify(title)}.json`);
}

function searchPath(wiki: WikiSource, query: string): string {
  return join(cacheRoot, wiki.id, "search", `${slugify(query.trim().toLowerCase())}.json`);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // A corrupt cache entry should cost a refetch, not crash the run.
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readCachedPage(
  wiki: WikiSource,
  title: string,
): Promise<WikiPage | undefined> {
  return readJson<WikiPage>(pagePath(wiki, title));
}

export async function writeCachedPage(wiki: WikiSource, page: WikiPage): Promise<void> {
  await writeJson(pagePath(wiki, page.resolvedTitle), page);
}

/** The query -> title resolution, cached so repeated asks skip opensearch. */
export interface CachedResolution {
  readonly query: string;
  /** null means no page on this wiki answers the query. */
  readonly resolution: TitleResolution | null;
  readonly candidates: readonly string[];
}

export async function readCachedResolution(
  wiki: WikiSource,
  query: string,
): Promise<CachedResolution | undefined> {
  return readJson<CachedResolution>(searchPath(wiki, query));
}

export async function writeCachedResolution(
  wiki: WikiSource,
  resolution: CachedResolution,
): Promise<void> {
  await writeJson(searchPath(wiki, resolution.query), resolution);
}

export function cachePathsFor(wiki: WikiSource, query: string, title?: string) {
  return {
    search: searchPath(wiki, query),
    page: title === undefined ? undefined : pagePath(wiki, title),
  };
}
