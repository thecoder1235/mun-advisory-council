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

import electron from "electron";

import { bootstrap } from "./app.ts";

/** Entry point. All wiring lives in app.ts so it can be booted by tests too. */

const { app, BrowserWindow } = electron;

void app.whenReady().then(async () => {
  await bootstrap();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
