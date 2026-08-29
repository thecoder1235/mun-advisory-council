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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the app keeps its profile, for the diagnostic scripts.
 *
 * These run under Electron but before `app.whenReady()` has settled a name, and
 * some of them need the path before Electron is involved at all. Two names are
 * possible: Electron derives userData from the app name, which is package.json
 * `name` in development and electron-builder's `productName` once packaged. On
 * macOS that distinction is real — the packaged bundle carries `productName` in
 * CFBundleName — so both are probed and whichever actually holds a settings
 * file wins.
 */
const APP_NAMES = ["mun-advisory-council", "MUN Advisory Council"];

function dirFor(appName) {
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, appName);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", appName);
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), appName);
}

export function profileCandidates() {
  return APP_NAMES.map(dirFor);
}

/** The profile that actually holds settings, or the first candidate if none do. */
export function resolveProfileDir() {
  const candidates = profileCandidates();
  return candidates.find((d) => existsSync(join(d, "settings.json"))) ?? candidates[0];
}
