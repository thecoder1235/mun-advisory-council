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

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  /** Environment variable holding the key, so keys never live in the repo. */
  readonly keyEnv: string;
  /** Used when neither the global setting nor a per-agent override names one. */
  readonly defaultModel: string;
  /** Free-tier ceiling. NVIDIA's is ~40/min, which parallel agents can hit. */
  readonly requestsPerMinute: number;
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly elapsedMs: number;
  /** Providers tried and rejected before this one answered. */
  readonly fellBackFrom: readonly string[];
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(provider: string, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.retryable = opts.retryable ?? false;
    if (opts.status !== undefined) this.status = opts.status;
  }
}
