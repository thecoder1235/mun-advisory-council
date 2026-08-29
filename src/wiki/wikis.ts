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
 * The four sources. Two publishers x two canons.
 *
 * Canon separation is the point of this table: every fact that leaves this layer
 * carries the canon it came from, so downstream agents can never silently merge
 * a comics weakness with a film one.
 */

export type Canon = "COMICS" | "FILM";
export type Publisher = "MARVEL" | "DC";

export interface WikiSource {
  /** Stable id, also used as the on-disk cache directory name. */
  readonly id: string;
  readonly host: string;
  readonly canon: Canon;
  readonly publisher: Publisher;
  /** Human label for the UI and CLI output. */
  readonly label: string;
}

export const WIKIS: readonly WikiSource[] = [
  {
    id: "marvel-comics",
    host: "marvel.fandom.com",
    canon: "COMICS",
    publisher: "MARVEL",
    label: "Marvel Comics",
  },
  {
    id: "marvel-film",
    host: "marvelcinematicuniverse.fandom.com",
    canon: "FILM",
    publisher: "MARVEL",
    label: "Marvel Cinematic Universe",
  },
  {
    id: "dc-comics",
    host: "dc.fandom.com",
    canon: "COMICS",
    publisher: "DC",
    label: "DC Comics",
  },
  {
    id: "dc-film",
    host: "dcextendeduniverse.fandom.com",
    canon: "FILM",
    publisher: "DC",
    label: "DC Extended Universe",
  },
];

export function wikiById(id: string): WikiSource | undefined {
  return WIKIS.find((w) => w.id === id);
}

export function wikisForPublisher(publisher: Publisher): readonly WikiSource[] {
  return WIKIS.filter((w) => w.publisher === publisher);
}
