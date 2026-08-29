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
 * Persisted user settings.
 *
 * Lives in Electron's userData directory, never in the bundle: the packaged exe
 * is read-only and shared, while this is per-user and writable. The delegate
 * receiving the exe has no source access, so everything needed to run the app
 * has to be reachable from inside it.
 */

export interface StoredSecret {
  /** How `value` was encoded. "none" means plaintext, used only where OS encryption is unavailable. */
  readonly scheme: string;
  readonly value: string;
}

export interface ProviderSettings {
  /** Absent means the user has not supplied a key for this provider. */
  readonly apiKey?: StoredSecret;
  /** Overrides the provider's built-in default model. */
  readonly model?: string;
}

export interface Settings {
  readonly version: 1;
  /** Provider id -> settings. Keys are stored here, never in the repo. */
  readonly providers: Readonly<Record<string, ProviderSettings>>;
  /** Fallback order by provider id. Empty means "every configured provider". */
  readonly providerOrder: readonly string[];
  /** Applies to every agent unless an agent overrides it. */
  readonly globalModel?: string;
  /** Agent name -> model id. */
  readonly agentModels: Readonly<Record<string, string>>;
  readonly outputLanguage: string;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  providers: {},
  providerOrder: [],
  agentModels: {},
  outputLanguage: "English",
};
