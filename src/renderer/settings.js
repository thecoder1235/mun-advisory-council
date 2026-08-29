/*
 * MUN Advisory Council — Copyright (C) 2026 MUN Advisory Council contributors
 * Licensed under the GNU Affero General Public License v3 or later.
 * See the LICENSE file in the project root for the full text.
 */

/**
 * Settings screen: key entry, per-role model pickers, fallback provider.
 *
 * Every dropdown is populated from the provider's live model list rather than a
 * list compiled into the app, and "Refresh" re-fetches it — a model released
 * this morning is selectable without a rebuild. Each role also keeps a
 * free-text field, so a model the provider does not list is still reachable.
 */

const $ = (id) => document.getElementById(id);
const PRIMARY = "nvidia";

let state = null;

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = `status ${kind ?? ""}`;
}

function providerOf(id) {
  return state?.providers.find((p) => p.id === id);
}

/** Models the pickers offer, from whichever provider is primary. */
function availableModels() {
  return providerOf(PRIMARY)?.models ?? [];
}

function renderKeySection() {
  const nvidia = providerOf(PRIMARY);
  const pill = $("key-pill");

  if (!nvidia?.configured) {
    pill.textContent = "not set";
    pill.className = "pill";
  } else if (nvidia.source === "env") {
    pill.textContent = "from .env (dev)";
    pill.className = "pill";
  } else {
    pill.textContent = "saved";
    pill.className = "pill on";
  }

  $("clear-key").disabled = !(nvidia?.configured && nvidia.source === "settings");
}

/**
 * A long verification needs to look like it is working.
 *
 * Naming a model can take a minute or more — NVIDIA queues the request while it
 * scales the model up. Without a visible, counting progress line that is
 * indistinguishable from the app having hung, which is exactly how it read
 * before.
 */
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

async function saveModelFor(role, value, statusEl) {
  const typed = value.trim();
  if (typed === "") {
    setStatus(statusEl, "Enter a model name first.", "err");
    return false;
  }

  if (/^(nvapi-|sk-|AIza|gsk_)/i.test(typed)) {
    setStatus(
      statusEl,
      "That looks like your API key, not a model name. Keys go in the API key field " +
        "at the top of this page. Nothing was sent.",
      "err",
    );
    return false;
  }

  const stop = startProgress(statusEl, `Checking ${typed}`);
  try {
    // Check before saving. A model typed by hand is exactly where a typo or a
    // model the account cannot reach would otherwise go unnoticed until the
    // first committee question.
    const check = await window.mun.models.verify(PRIMARY, typed);
    stop();
    if (check.requestLog) showLog(check.requestLog);

    if (!check.ok) {
      // A timeout leaves the name unproven rather than wrong, so it is offered
      // for saving anyway instead of being thrown away.
      if (check.inconclusive) {
        const result = await window.mun.settings.setRoleModel(role.id, typed);
        state = result.state;
        renderRoles();
        setStatus(statusEl, `${check.message} Saved anyway as ${role.label} so you can retry.`, "err");
        return true;
      }
      setStatus(statusEl, check.message, "err");
      return false;
    }

    const result = await window.mun.settings.setRoleModel(role.id, typed);
    state = result.state;
    renderRoles();
    setStatus(statusEl, `${role.label} set to ${typed}. ${check.message}`, "ok");
    return true;
  } catch (err) {
    stop();
    setStatus(statusEl, `Could not check: ${err.message ?? err}`, "err");
    return false;
  }
}

function renderRoles() {
  const models = availableModels();
  const container = $("roles");
  container.innerHTML = "";

  // With a per-model key the catalog is unreachable by design, so say plainly
  // that typing the name is the normal path rather than an escape hatch.
  const banner = $("model-banner");
  if (models.length === 0) {
    banner.hidden = false;
    banner.className = "banner";
    banner.innerHTML =
      "<strong>Enter your model name below.</strong> NVIDIA issues API keys from each model's own page, " +
      "and a key made that way can only call that one model — so it cannot be discovered automatically. " +
      "Copy the model name exactly as it appears on the page where you generated your key.";
  } else {
    banner.hidden = true;
  }

  for (const role of state.roles) {
    const wrap = document.createElement("div");
    wrap.className = "role";

    const label = document.createElement("label");
    label.textContent = role.label;
    label.setAttribute("for", `role-${role.id}`);
    wrap.append(label);

    // The dropdown is only meaningful when the catalog is actually callable.
    if (models.length > 0) {
      const select = document.createElement("select");
      select.id = `role-${role.id}`;

      // "Inherit" is a real choice, not a placeholder: leaving a role unset is
      // how an agent follows the default.
      const inheritLabel =
        role.id === "default"
          ? `Provider default (${providerOf(PRIMARY)?.defaultModel ?? "unknown"})`
          : "Same as default model";
      select.append(new Option(inheritLabel, ""));
      for (const model of models) select.append(new Option(model, model));

      // A saved model missing from the catalog must still show as selected,
      // otherwise the screen would misreport what the app will run.
      if (role.model && !models.includes(role.model)) {
        select.append(new Option(`${role.model} (not in list)`, role.model));
      }
      select.value = role.model ?? "";

      select.addEventListener("change", async () => {
        const result = await window.mun.settings.setRoleModel(role.id, select.value);
        state = result.state;
        setStatus($("model-status"), `${role.label}: ${select.value || "inherit"}`, "ok");
      });
      wrap.append(select);
    }

    const escapeLabel = document.createElement("p");
    escapeLabel.className = "escape-label";
    escapeLabel.textContent =
      models.length > 0
        ? "Or enter a model name directly:"
        : `Model name for ${role.label.toLowerCase()}:`;

    const row = document.createElement("div");
    row.className = "escape-row";

    const input = document.createElement("input");
    input.className = "escape";
    input.spellcheck = false;
    input.placeholder = "e.g. deepseek-ai/deepseek-v4-pro-0813";
    // Show what is currently saved rather than an empty box, so the field
    // reflects the real state instead of looking unset.
    input.value = role.model ?? "";

    const save = document.createElement("button");
    save.textContent = "Save";
    save.className = role.id === "default" ? "primary" : "";

    const status = document.createElement("div");
    status.className = "status";

    const submit = async () => {
      save.disabled = true;
      input.disabled = true;
      try {
        await saveModelFor(role, input.value, status);
      } finally {
        save.disabled = false;
        input.disabled = false;
      }
    };

    save.addEventListener("click", submit);
    // Enter submits too; relying on the blur-only `change` event meant clicking
    // any other button raced the save and the typed value was discarded.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    });

    row.append(input, save);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = role.hint;

    wrap.append(escapeLabel, row, status, hint);
    container.append(wrap);
  }

  const nvidia = providerOf(PRIMARY);
  $("catalog-meta").textContent = nvidia?.modelsFetchedAt
    ? `${models.length} models listed, updated ${new Date(nvidia.modelsFetchedAt).toLocaleString()}`
    : "No model list — this is normal for a per-model key.";
}

function renderFallback() {
  const select = $("fallback");
  select.innerHTML = "";
  select.append(new Option("None", ""));

  for (const p of state.providers) {
    if (p.id === PRIMARY) continue;
    const label = p.configured ? p.label : `${p.label} (no key set)`;
    const option = new Option(label, p.id);
    option.disabled = !p.configured;
    select.append(option);
  }

  const current = state.providerOrder.find((id) => id !== PRIMARY) ?? "";
  select.value = current;

  const configuredFallbacks = state.providers.filter((p) => p.id !== PRIMARY && p.configured);
  $("fallback-hint").textContent =
    configuredFallbacks.length === 0
      ? "No other provider has a key yet. Fallbacks currently need a key in a .env file; a second key field is not built yet."
      : "Tried when the primary provider fails or is rate-limited.";

  select.onchange = async () => {
    const order = select.value === "" ? [PRIMARY] : [PRIMARY, select.value];
    const result = await window.mun.settings.setProviderOrder(order);
    state = result.state;
    setStatus($("model-status"), "Fallback order saved.", "ok");
  };
}

function renderAll() {
  renderKeySection();
  renderRoles();
  renderFallback();
  $("footer").innerHTML = `Stored at <code>${state.settingsPath}</code>. ${
    state.encryptionAvailable
      ? "Keys are encrypted with your Windows account."
      : "<strong>OS encryption unavailable — keys are stored as plain text.</strong>"
  }`;
}

$("back").addEventListener("click", () => window.mun.navigate("council.html"));
$("link-nvidia").addEventListener("click", () => window.mun.openExternal("https://build.nvidia.com/"));
// Reachable again after first run: nobody remembers the per-model key rule.
$("open-guide").addEventListener("click", () => window.mun.navigate("setup.html"));

$("save-key").addEventListener("click", async () => {
  const key = $("key").value.trim();
  if (key === "") {
    setStatus($("key-status"), "Paste a key first.", "err");
    return;
  }

  $("save-key").disabled = true;
  setStatus($("key-status"), "Checking key and loading models...", "busy");
  try {
    // Saving validates: the models call is the check, so a rejected key is
    // never stored and the dropdowns fill from the same response.
    const result = await window.mun.settings.saveKey(PRIMARY, key);
    if (result.requestLog) showLog(result.requestLog);
    if (!result.ok) {
      setStatus($("key-status"), result.message, "err");
      // Nothing was proven either way; steer to the connection test rather than
      // leaving the user to assume the key is bad.
      if (result.inconclusive) {
        setStatus(
          $("conn-status"),
          'This was a connection failure, not a rejection. Try "Test connection" below.',
          "err",
        );
      }
      return;
    }
    $("key").value = "";
    state = result.state;
    renderAll();

    if (result.modelReachable === false) {
      // The key is good and has been stored; only the model is missing. Point
      // at the field that fixes it rather than implying the key is at fault.
      setStatus($("key-status"), result.message, "ok");
      document.querySelector("#roles input.escape")?.focus();
      return;
    }

    setStatus($("key-status"), result.message, "ok");
  } catch (err) {
    setStatus($("key-status"), `Could not save: ${err.message ?? err}`, "err");
  } finally {
    $("save-key").disabled = false;
  }
});

$("clear-key").addEventListener("click", async () => {
  const result = await window.mun.settings.clearKey(PRIMARY);
  state = result.state;
  renderAll();
  setStatus($("key-status"), result.message, "ok");
});

$("refresh").addEventListener("click", async () => {
  $("refresh").disabled = true;
  setStatus($("model-status"), "Refreshing model list...", "busy");
  try {
    const result = await window.mun.models.refresh();
    state = result.state;
    renderAll();
    const primary = result.results[PRIMARY];
    setStatus($("model-status"), primary?.message ?? "Refreshed.", primary?.ok ? "ok" : "err");
  } catch (err) {
    setStatus($("model-status"), `Refresh failed: ${err.message ?? err}`, "err");
  } finally {
    $("refresh").disabled = false;
  }
});

// The startup refresh runs in the background, so the screen may open against a
// cached list and need updating a moment later.
window.mun.models.onUpdated((updated) => {
  state = updated;
  renderAll();
});

(async () => {
  state = await window.mun.settings.state();
  renderAll();
})();

// --- Diagnostics ------------------------------------------------------------

/**
 * A timeout is not a rejection. Whenever a check comes back `inconclusive`, the
 * message says what actually happened and points at the connection test rather
 * than implying the key or model is wrong.
 */
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

$("test-connection").addEventListener("click", async () => {
  const btn = $("test-connection");
  btn.disabled = true;
  setStatus($("conn-status"), "Testing connection...", "busy");
  try {
    const result = await window.mun.diagnostics.testConnection(PRIMARY);
    setStatus($("conn-status"), result.message, result.ok ? "ok" : "err");
    if (result.requestLog) showLog(result.requestLog);
  } catch (err) {
    setStatus($("conn-status"), `Test failed: ${err.message ?? err}`, "err");
  } finally {
    btn.disabled = false;
  }
});
