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

const { contextBridge, ipcRenderer } = electron;

/**
 * The renderer never touches Node, the filesystem, or the network directly.
 * Every capability it gets is added here explicitly and narrowly — in
 * particular the renderer can ask for a key to be saved, checked or removed,
 * but there is no call that returns a stored key.
 */
contextBridge.exposeInMainWorld("mun", {
  version: "0.1.0",
  settings: {
    state: () => ipcRenderer.invoke("settings:state"),
    checkKey: (providerId: string, apiKey: string) =>
      ipcRenderer.invoke("settings:checkKey", providerId, apiKey),
    saveKey: (providerId: string, apiKey: string) =>
      ipcRenderer.invoke("settings:saveKey", providerId, apiKey),
    clearKey: (providerId: string) => ipcRenderer.invoke("settings:clearKey", providerId),
    setRoleModel: (role: string, model: string) =>
      ipcRenderer.invoke("settings:setRoleModel", role, model),
    setProviderOrder: (order: readonly string[]) =>
      ipcRenderer.invoke("settings:setProviderOrder", order),
    continue: () => ipcRenderer.invoke("settings:continue"),
  },
  models: {
    refresh: () => ipcRenderer.invoke("models:refresh"),
    verify: (providerId: string, model: string) =>
      ipcRenderer.invoke("models:verify", providerId, model),
    /** Fired when the background startup refresh finds a newer catalog. */
    onUpdated: (handler: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown): void => handler(state);
      ipcRenderer.on("models:updated", listener);
      return () => ipcRenderer.removeListener("models:updated", listener);
    },
  },
  council: {
    addCharacter: (name: string, overrides?: Record<string, string>) =>
      ipcRenderer.invoke("council:addCharacter", name, overrides),
    ask: (question: string, characters: readonly string[], forceAgents: readonly string[]) =>
      ipcRenderer.invoke("council:ask", question, characters, forceAgents),
    agents: () => ipcRenderer.invoke("council:agents"),
    history: () => ipcRenderer.invoke("council:history"),
    liveRun: () => ipcRenderer.invoke("council:liveRun"),
    answer: (id: string) => ipcRenderer.invoke("council:answer", id),
    guide: () => ipcRenderer.invoke("council:guide"),
    /** Progress events, so cards can appear as each agent finishes. */
    onEvent: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on("council:event", listener);
      return () => ipcRenderer.removeListener("council:event", listener);
    },
  },
  warmth: {
    status: () => ipcRenderer.invoke("warmth:status"),
    warm: () => ipcRenderer.invoke("warmth:warm"),
    onChange: (handler: (status: unknown) => void) => {
      const listener = (_e: unknown, status: unknown): void => handler(status);
      ipcRenderer.on("warmth", listener);
      return () => ipcRenderer.removeListener("warmth", listener);
    },
  },
  diagnostics: {
    testConnection: (providerId: string) =>
      ipcRenderer.invoke("diagnostics:testConnection", providerId),
    log: () => ipcRenderer.invoke("diagnostics:log"),
  },
  navigate: (page: string) => ipcRenderer.invoke("navigate", page),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
});
