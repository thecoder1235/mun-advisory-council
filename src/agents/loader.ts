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

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Agent directives are markdown on disk, read at call time rather than compiled
 * in. Editing agents/canon-keeper.md changes behaviour with no rebuild, which
 * is the point — prompt tuning is the main lever this app has.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/agents -> project root, and dist/agents -> project root. Both are two up. */
const PROJECT_ROOT = resolve(HERE, "..", "..");

let agentsDir = process.env["MUN_AGENTS_DIR"]
  ? resolve(process.env["MUN_AGENTS_DIR"])
  : join(PROJECT_ROOT, "agents");

/** Packaged builds ship agents/ as an extra resource outside the asar. */
export function setAgentsDir(dir: string): void {
  agentsDir = resolve(dir);
}

export function getAgentsDir(): string {
  return agentsDir;
}

export const SHARED_RULES = "shared-rules";

export async function loadPrompt(name: string): Promise<string> {
  const path = join(agentsDir, `${name}.md`);
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`agent prompt not found: ${path}`);
    throw err;
  }
}

/**
 * An agent's full directive: shared rules first, then its own.
 *
 * Order matters. shared-rules.md states that it overrides individual
 * directives, and the never-invent and canon-tagging rules in it are the ones
 * this whole app depends on.
 */
export async function buildDirective(agent: string, focusNote?: string): Promise<string> {
  const [shared, own] = await Promise.all([loadPrompt(SHARED_RULES), loadPrompt(agent)]);
  const parts = [shared, own];
  if (focusNote !== undefined && focusNote.trim() !== "") {
    // The router's note is appended to the agent's directive, never a
    // replacement for it — the router advises, it does not rewrite the agent.
    parts.push(`## Focus for this question\n\n${focusNote.trim()}`);
  }
  return parts.join("\n\n---\n\n");
}
