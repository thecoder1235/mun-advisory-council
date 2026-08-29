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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { listModels, type ProviderConfig } from "../providers/index.ts";

/**
 * The list of models each provider offers, fetched rather than hardcoded.
 *
 * Cached to userData so the settings screen has something to show immediately
 * on launch and still works with no connection. The cache is a convenience, not
 * a source of truth: "Refresh" always re-fetches, so a model released this
 * morning is selectable without a rebuild.
 */

export interface ProviderCatalog {
  readonly models: readonly string[];
  readonly fetchedAt: string;
}

export type ModelCatalog = Readonly<Record<string, ProviderCatalog>>;

export function catalogPath(userDataDir: string): string {
  return join(userDataDir, "model-catalog.json");
}

export async function loadCatalog(userDataDir: string): Promise<ModelCatalog> {
  try {
    const raw = JSON.parse(await readFile(catalogPath(userDataDir), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return {};
    return raw as ModelCatalog;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || err instanceof SyntaxError) return {};
    throw err;
  }
}

export async function saveCatalog(userDataDir: string, catalog: ModelCatalog): Promise<void> {
  const path = catalogPath(userDataDir);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export interface RefreshOutcome {
  readonly catalog: ModelCatalog;
  /** Provider id -> what happened, for the settings screen to report. */
  readonly results: Readonly<Record<string, { ok: boolean; message: string; count: number }>>;
}

/**
 * Re-fetch model lists for every provider that has a key.
 *
 * A provider that fails keeps whatever it had cached: losing a usable list
 * because the network blipped would be worse than showing a slightly stale one,
 * and the screen reports the failure either way.
 */
export async function refreshCatalog(
  userDataDir: string,
  providers: readonly ProviderConfig[],
  apiKeys: Readonly<Record<string, string>>,
  previous: ModelCatalog,
): Promise<RefreshOutcome> {
  const catalog: Record<string, ProviderCatalog> = { ...previous };
  const results: Record<string, { ok: boolean; message: string; count: number }> = {};

  for (const provider of providers) {
    const key = apiKeys[provider.id];
    if (key === undefined || key.trim() === "") {
      results[provider.id] = { ok: false, message: "No API key set.", count: 0 };
      continue;
    }

    const result = await listModels(provider, key);
    if (result.ok) {
      catalog[provider.id] = {
        models: result.models,
        fetchedAt: new Date().toISOString(),
      };
      results[provider.id] = { ok: true, message: result.message, count: result.models.length };
    } else {
      const kept = previous[provider.id]?.models.length ?? 0;
      results[provider.id] = {
        ok: false,
        message: kept > 0 ? `${result.message} Showing ${kept} cached model(s).` : result.message,
        count: kept,
      };
    }
  }

  await saveCatalog(userDataDir, catalog);
  return { catalog, results };
}
