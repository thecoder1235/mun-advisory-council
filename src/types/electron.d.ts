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
 * Pulls Electron's type declarations into the program.
 *
 * Electron ships no physical `electron/main` or `electron/renderer` files in
 * node_modules — those specifiers exist only inside the Electron runtime, and
 * are typed by ambient `declare module` blocks in electron.d.ts. Without this
 * reference those blocks are never loaded, so the ESM subpath imports and the
 * `process.resourcesPath` augmentation both fail to resolve.
 */
/// <reference types="electron" />
