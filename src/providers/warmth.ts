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

import { request } from "./http.ts";
import type { ProviderConfig } from "./types.ts";

/**
 * Keeping the model provisioned.
 *
 * NVIDIA serves these models through Cloud Functions that scale from zero. A
 * model nobody has called for a while is cold, and the first request pays the
 * full provisioning cost — measured at 84-111 seconds for deepseek-v4-pro. A
 * council fires six of those, so a first question from cold took twelve
 * minutes. That is unusable in a committee.
 *
 * The fix is to pay that cost before the delegate asks anything: fire one
 * throwaway token at launch, while they are still reading the setup screen, and
 * keep a small ping going so the model does not go cold again mid-session.
 *
 * Pings are cheap (one token) but not free, so they stop when the window is
 * hidden or the session has gone idle. Burning a free-tier rate limit on an app
 * nobody is looking at would be its own kind of failure.
 */

export type WarmthState = "cold" | "warming" | "warm" | "failed";

export interface WarmthStatus {
  readonly state: WarmthState;
  readonly model: string | null;
  /** How long the last successful warm-up call took. */
  readonly lastLatencyMs: number | null;
  readonly lastSuccessAt: string | null;
  readonly message: string;
}

/** Gap between keep-alive pings while the app is in use. */
const PING_INTERVAL_MS = 4 * 60_000;
/** After this long with no question and no window focus, stop pinging. */
const IDLE_TIMEOUT_MS = 20 * 60_000;
/** A warm-up call should not hold a slot forever if the model is wedged. */
const WARMUP_TIMEOUT_MS = 300_000;

export class ModelWarmer {
  #provider: ProviderConfig;
  #getKey: () => string | undefined;
  #getModel: () => string | undefined;
  #onChange: (status: WarmthStatus) => void;

  #state: WarmthState = "cold";
  #model: string | null = null;
  #lastLatencyMs: number | null = null;
  #lastSuccessAt: string | null = null;
  #message = "Not started.";

  #timer: NodeJS.Timeout | null = null;
  #inFlight = false;
  #lastActivity = Date.now();
  #visible = true;

  constructor(opts: {
    provider: ProviderConfig;
    getKey: () => string | undefined;
    getModel: () => string | undefined;
    onChange?: (status: WarmthStatus) => void;
  }) {
    this.#provider = opts.provider;
    this.#getKey = opts.getKey;
    this.#getModel = opts.getModel;
    this.#onChange = opts.onChange ?? (() => {});
  }

  status(): WarmthStatus {
    return {
      state: this.#state,
      model: this.#model,
      lastLatencyMs: this.#lastLatencyMs,
      lastSuccessAt: this.#lastSuccessAt,
      message: this.#message,
    };
  }

  #set(state: WarmthState, message: string): void {
    this.#state = state;
    this.#message = message;
    this.#onChange(this.status());
  }

  /** Called whenever the delegate does something, to keep the session alive. */
  noteActivity(): void {
    this.#lastActivity = Date.now();
  }

  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (visible) this.noteActivity();
  }

  start(): void {
    this.noteActivity();
    void this.warmNow();
    if (this.#timer === null) {
      this.#timer = setInterval(() => void this.#tick(), PING_INTERVAL_MS);
      // Never hold the process open just to ping a model.
      this.#timer.unref?.();
    }
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #tick(): Promise<void> {
    // A hidden window or a long-idle session does not need a warm model, and
    // pinging anyway would spend the delegate's rate limit for nothing.
    if (!this.#visible) return;
    if (Date.now() - this.#lastActivity > IDLE_TIMEOUT_MS) return;
    await this.warmNow();
  }

  /**
   * Fire one throwaway token. Never throws: warming is best-effort, and a
   * failure here must not affect anything the delegate is doing.
   */
  async warmNow(): Promise<WarmthStatus> {
    const key = this.#getKey();
    const model = this.#getModel();

    if (key === undefined || key.trim() === "" || model === undefined || model.trim() === "") {
      this.#set("cold", "Waiting for an API key and model.");
      return this.status();
    }
    if (this.#inFlight) return this.status();

    this.#inFlight = true;
    this.#model = model;
    // Only announce "warming" on the first pass; later pings are invisible so
    // the UI does not flicker between states during normal use.
    if (this.#state !== "warm") this.#set("warming", `Starting ${model}…`);

    const started = Date.now();
    try {
      const result = await request(`${this.#provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
          stream: false,
        }),
        timeoutMs: WARMUP_TIMEOUT_MS,
        model,
      });

      const elapsed = Date.now() - started;
      if (result.ok || result.status === 429) {
        // 429 means the model answered the door; it is warm, just busy.
        this.#lastLatencyMs = elapsed;
        this.#lastSuccessAt = new Date().toISOString();
        this.#set("warm", `Ready (${(elapsed / 1000).toFixed(1)}s).`);
      } else {
        this.#set("failed", `Could not warm ${model}: ${result.failure?.name ?? "unknown"}.`);
      }
    } catch (err) {
      this.#set("failed", `Could not warm ${model}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#inFlight = false;
    }

    return this.status();
  }
}
