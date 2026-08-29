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
 * Two things tsc does not do:
 *
 * 1. Electron decides whether a preload script is ESM by file extension and
 *    only accepts .mjs, while tsc emits .js.
 * 2. The renderer is plain HTML/JS, so it is copied into dist/ to make the
 *    build output self-contained — packaging then ships dist/ alone, and the
 *    main process can resolve renderer files relative to itself instead of
 *    through app.getAppPath(), which follows whichever script launched
 *    Electron rather than the app root.
 */
import { copyFile, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const mainDir = join(root, "dist", "main");

await mkdir(mainDir, { recursive: true });
await copyFile(join(mainDir, "preload.js"), join(mainDir, "preload.mjs"));
await cp(join(root, "src", "renderer"), join(root, "dist", "renderer"), { recursive: true });

console.log("postbuild: preload.mjs written, renderer copied to dist/renderer");
