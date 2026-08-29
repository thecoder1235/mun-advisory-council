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

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CouncilAnswer } from "./run.ts";

/**
 * Questions and answers persisted to disk, so earlier sessions can be reviewed.
 *
 * One file per answer rather than a single growing log: a committee session
 * produces a handful of large answers, and a corrupt write should cost one
 * entry rather than the whole record.
 */

export interface HistoryEntry extends CouncilAnswer {
  readonly id: string;
}

function historyDir(userDataDir: string): string {
  return join(userDataDir, "history");
}

export async function saveAnswer(
  userDataDir: string,
  answer: CouncilAnswer,
): Promise<HistoryEntry> {
  const dir = historyDir(userDataDir);
  await mkdir(dir, { recursive: true });

  // Timestamp-prefixed so the directory sorts chronologically on its own.
  const id = `${answer.askedAt.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: HistoryEntry = { ...answer, id };
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return entry;
}

export interface HistorySummary {
  readonly id: string;
  readonly askedAt: string;
  readonly question: string;
  readonly characters: readonly string[];
  readonly outcome: string;
  readonly agentCount: number;
}

export async function listHistory(userDataDir: string, limit = 50): Promise<HistorySummary[]> {
  const dir = historyDir(userDataDir);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const entries: HistorySummary[] = [];
  for (const file of files.sort().reverse().slice(0, limit)) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as HistoryEntry;
      entries.push({
        id: parsed.id,
        askedAt: parsed.askedAt,
        question: parsed.question,
        characters: parsed.characters ?? [],
        outcome: parsed.outcome,
        agentCount: parsed.results?.length ?? 0,
      });
    } catch {
      // A corrupt entry is skipped rather than breaking the list.
    }
  }
  return entries;
}

export async function readAnswer(
  userDataDir: string,
  id: string,
): Promise<HistoryEntry | undefined> {
  // Ids are generated here and are timestamp+random; reject anything else
  // rather than letting a renderer-supplied string reach the filesystem.
  if (!/^[0-9TZ.\-a-z0-9]+$/i.test(id) || id.includes("..") || id.includes("/") || id.includes("\\")) {
    return undefined;
  }
  try {
    const raw = await readFile(join(historyDir(userDataDir), `${id}.json`), "utf8");
    return JSON.parse(raw) as HistoryEntry;
  } catch {
    return undefined;
  }
}
