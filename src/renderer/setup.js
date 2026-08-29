/*
 * MUN Advisory Council — Copyright (C) 2026 MUN Advisory Council contributors
 * Licensed under the GNU Affero General Public License v3 or later.
 * See the LICENSE file in the project root for the full text.
 */

/**
 * First-run setup. Plain JS rather than TypeScript because it is loaded
 * directly by the renderer with no build step; the main UI will be compiled.
 *
 * The key is only ever sent to the main process — it is never held anywhere the
 * renderer can read back, and the input is cleared once saved.
 */

const $ = (id) => document.getElementById(id);
const keyInput = $("key");
const checkBtn = $("check");
const saveBtn = $("save");
const statusEl = $("status");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status ${kind ?? ""}`;
}

$("link-nvidia").addEventListener("click", () => {
  window.mun.openExternal("https://build.nvidia.com/");
});

// Save is enabled as soon as something is typed; validation happens on save.
keyInput.addEventListener("input", () => {
  saveBtn.disabled = keyInput.value.trim() === "";
  setStatus("");
});

function showLog(text) {
  const el = $("log");
  el.textContent = text || "(no requests recorded)";
  el.hidden = false;
  $("toggle-log").textContent = "Hide request details";
}

$("toggle-log").addEventListener("click", async () => {
  const el = $("log");
  if (!el.hidden) {
    el.hidden = true;
    $("toggle-log").textContent = "Show request details";
    return;
  }
  const result = await window.mun.diagnostics.log();
  showLog(result.text);
});

// Reachability only: no key, no model. This is what separates "the network is
// blocked" from "the key is wrong", which otherwise look identical.
$("test-connection").addEventListener("click", async () => {
  const btn = $("test-connection");
  btn.disabled = true;
  setStatus("Testing connection...", "busy");
  try {
    const result = await window.mun.diagnostics.testConnection("nvidia");
    setStatus(result.message, result.ok ? "ok" : "err");
    if (result.requestLog) showLog(result.requestLog);
  } catch (err) {
    setStatus(`Test failed: ${err.message ?? err}`, "err");
  } finally {
    btn.disabled = false;
  }
});

checkBtn.addEventListener("click", async () => {
  const key = keyInput.value.trim();
  if (key === "") {
    setStatus("Paste your key first.", "err");
    return;
  }

  checkBtn.disabled = true;
  setStatus("Checking...", "busy");
  try {
    const result = await window.mun.settings.checkKey("nvidia", key);
    if (result.requestLog) showLog(result.requestLog);
    setStatus(result.message, result.ok ? "ok" : "err");
    saveBtn.disabled = false;
  } catch (err) {
    setStatus(`Check failed: ${err.message ?? err}`, "err");
  } finally {
    checkBtn.disabled = false;
  }
});

saveBtn.addEventListener("click", async () => {
  const key = keyInput.value.trim();
  if (key === "") return;

  saveBtn.disabled = true;
  setStatus("Saving...", "busy");
  try {
    // Saving validates against GET /v1/models. A key that does not work is
    // never stored, so the app cannot end up "configured" but unable to answer.
    const result = await window.mun.settings.saveKey("nvidia", key);
    if (result.requestLog) showLog(result.requestLog);
    if (!result.ok) {
      setStatus(result.message, "err");
      saveBtn.disabled = false;
      return;
    }
    keyInput.value = "";
    setStatus(result.message, "ok");

    // The key authenticated but nothing it can reach was found. That is a model
    // problem, not a key problem, so ask for the model rather than sending the
    // user back to regenerate a key that already works.
    if (result.modelReachable === false) {
      showModelStep();
      return;
    }

    await window.mun.settings.continue();
  } catch (err) {
    setStatus(`Could not save: ${err.message ?? err}`, "err");
    saveBtn.disabled = false;
  }
});

function showModelStep() {
  $("model-step").hidden = false;
  // Not framed as a failure: with a per-model key this is simply how setup
  // finishes, because the key can only call the model it was made for.
  $("model-why").textContent =
    "NVIDIA issues API keys from each model's own page, and a key made that way can only call that " +
    "one model — so we cannot detect it for you. Copy the model name exactly as it appears on the " +
    "page where you generated your key.";
  $("model").focus();
  saveBtn.disabled = true;
  checkBtn.disabled = true;
}

/** Counting progress, so a slow verification does not look like a hang. */
function startProgress(el, label) {
  const began = Date.now();
  const tick = () => {
    const secs = Math.round((Date.now() - began) / 1000);
    el.innerHTML = `<span class="spinner"></span>${label} (${secs}s)`;
    el.className = "status busy";
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

$("save-model").addEventListener("click", async () => {
  const model = $("model").value.trim();
  const status = $("model-status");
  if (model === "") {
    status.textContent = "Enter a model name first.";
    status.className = "status err";
    return;
  }

  // Caught in the renderer as well as the main process, so the mistake is
  // named instantly rather than after a round trip.
  if (/^(nvapi-|sk-|AIza|gsk_)/i.test(model)) {
    status.textContent =
      "That looks like your API key, not a model name. The key goes in the field above; " +
      "this one wants the model id from the page you generated the key on, for example " +
      "deepseek-ai/deepseek-v4-pro-0813. Nothing was sent.";
    status.className = "status err";
    return;
  }

  $("save-model").disabled = true;
  const stop = startProgress(status, `Checking ${model}`);
  try {
    // Confirm before saving: a typo here would otherwise surface mid-committee.
    const check = await window.mun.models.verify("nvidia", model);
    stop();
    if (check.requestLog) showLog(check.requestLog);

    if (!check.ok) {
      // A timeout proves nothing about the name, so keep it rather than making
      // the user retype it, and let them move on and retry later.
      if (check.inconclusive) {
        await window.mun.settings.setRoleModel("default", model);
        status.textContent = `${check.message} Saved anyway — you can continue and retry later.`;
        status.className = "status err";
        $("save-model").textContent = "Continue anyway";
        $("save-model").onclick = () => window.mun.settings.continue();
        return;
      }
      status.textContent = check.message;
      status.className = "status err";
      return;
    }

    await window.mun.settings.setRoleModel("default", model);
    status.textContent = check.message;
    status.className = "status ok";
    await window.mun.settings.continue();
  } catch (err) {
    stop();
    status.textContent = `Could not check: ${err.message ?? err}`;
    status.className = "status err";
  } finally {
    $("save-model").disabled = false;
  }
});

// Tell the user where the key will live, and be honest when the OS keystore is
// not available to encrypt it.
(async () => {
  try {
    const state = await window.mun.settings.state();
    const nvidia = state.providers.find((p) => p.id === "nvidia");

    const lines = [
      `Your key is stored on this computer only, at <code>${state.settingsPath}</code>.`,
      state.encryptionAvailable
        ? "It is encrypted with your Windows account."
        : "<strong>Note:</strong> OS encryption is unavailable here, so the key is stored as plain text.",
    ];

    if (nvidia?.configured && nvidia.source === "env") {
      lines.push("A key was found in a development <code>.env</code> file. Saving here will take precedence over it.");
    }

    $("note").innerHTML = lines.join("<br />");
  } catch {
    $("note").textContent = "";
  }
})();


// Warming starts as soon as a key and model exist, so by the time the delegate
// reaches the council screen the first question is much faster.
window.mun.warmth.onChange((status) => {
  const node = $("warmnote");
  if (!node) return;
  node.textContent =
    status.state === "warming"
      ? "Starting your model in the background so your first question is fast…"
      : status.state === "warm"
        ? `Model ready (${((status.lastLatencyMs ?? 0) / 1000).toFixed(1)}s).`
        : "";
});


// When the guide is opened from Settings rather than on first run, there has to
// be a way back that does not require re-entering a key.
(async () => {
  try {
    const state = await window.mun.settings.state();
    if (state.providers.some((p) => p.configured)) {
      const back = $("back-to-app");
      back.hidden = false;
      back.addEventListener("click", () => window.mun.navigate("council.html"));
    }
  } catch {
    /* the button is a convenience; never block setup on it */
  }
})();
