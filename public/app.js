/* TsAgent web chat — vanilla JS, no build step. */

const $ = (sel) => document.querySelector(sel);

const state = {
  models: [],
  modelId: null,
  messages: [], // { role, content }
  streaming: false,
  controller: null,
  system: "",
  temperature: 0.7,
};

const els = {
  model: $("#model"),
  hint: $("#model-hint"),
  messages: $("#messages"),
  empty: $("#empty"),
  input: $("#input"),
  send: $("#btn-send"),
  stop: $("#btn-stop"),
  clear: $("#btn-clear"),
  status: $("#status"),
  settings: $("#settings"),
  detail: $("#model-detail"),
  system: $("#system"),
  temperature: $("#temperature"),
  tempValue: $("#temp-value"),
  modelList: $("#model-list"),
  modelForm: $("#model-form"),
  addModel: $("#btn-add-model"),
  formTitle: $("#form-title"),
  formNote: $("#form-note"),
  cancelForm: $("#btn-cancel-form"),
  storePath: $("#store-path"),
  f: {
    label: $("#f-label"),
    provider: $("#f-provider"),
    baseurl: $("#f-baseurl"),
    model: $("#f-model"),
    id: $("#f-id"),
    key: $("#f-key"),
    nokey: $("#f-nokey"),
  },
};

let editingId = null;

/* ---------------- helpers ---------------- */

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function mdToHtml(src) {
  const blocks = [];
  let text = src.replace(/```([\w-]*)\r?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const i =
      blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`) - 1;
    return `\u0000B${i}\u0000`;
  });

  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  text = text
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>");

  text = text.replace(/(?:^[-*] .*(?:\n|$))+/gm, (m) => {
    const items = m
      .trim()
      .split("\n")
      .map((line) => `<li>${line.replace(/^[-*] /, "")}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  });

  const html = text
    .split(/\n{2,}/)
    .map((chunk) => {
      const t = chunk.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|pre|li|blockquote)/.test(t) || /^\u0000B\d+\u0000$/.test(t)) return t;
      return `<p>${t.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  return html.replace(/\u0000B(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? "");
}

function setStatus(text, isError = false) {
  els.status.textContent = text || "";
  els.status.classList.toggle("error", Boolean(isError));
}

function nearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

/* ---------------- models ---------------- */

async function loadModels() {
  setStatus("加载模型列表…");
  try {
    const res = await fetch("/api/models");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.models = data.models ?? [];
    renderModelOptions(data);
    renderModelList();
    if (els.storePath && data.store) els.storePath.textContent = data.store;
    setStatus("");
    if (data.warnings?.length) setStatus(data.warnings.join("; "), true);
  } catch (err) {
    setStatus(`模型列表加载失败：${err.message}`, true);
    els.model.innerHTML = '<option value="">（无法加载）</option>';
  }
}

function renderModelOptions(data) {
  els.model.innerHTML = "";
  const groups = new Map();
  for (const m of state.models) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }

  for (const [provider, list] of groups) {
    const group = document.createElement("optgroup");
    group.label = provider;
    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.available ? `${m.label} · ${m.model}` : `${m.label} · ${m.model}（未配置 key）`;
      group.appendChild(opt);
    }
    els.model.appendChild(group);
  }

  const wanted = state.modelId ?? localStorage.getItem("tsagent.model");
  const pick =
    state.models.find((m) => m.id === wanted) ??
    state.models.find((m) => m.available) ??
    state.models[0];
  if (pick) {
    state.modelId = pick.id;
    els.model.value = pick.id;
    localStorage.setItem("tsagent.model", pick.id);
  } else {
    state.modelId = null;
  }

  if (data.source === "built-in") {
    state.hint.textContent = "使用内置模型列表";
    state.hint.classList.add("warn");
  }
  updateModelDetail();
}

function updateModelDetail() {
  const m = state.models.find((m) => m.id === state.modelId);
  if (!m) {
    els.detail.textContent = "—";
    return;
  }
  els.detail.innerHTML = [
    `id: <b>${escapeHtml(m.id)}</b>`,
    `provider: ${escapeHtml(m.provider)}`,
    `model: ${escapeHtml(m.model)}`,
    `状态: ${m.available ? "可用" : `不可用（${escapeHtml(m.reason ?? "no key")}）`}`,
  ].join("<br>");

  els.hint.textContent = m.available ? m.model : m.reason ?? "未配置 key";
  els.hint.classList.toggle("warn", !m.available);
}

/* ---------------- model manager ---------------- */

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "model";
}

function actionButton(label, onClick, extraClass = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (extraClass) b.className = extraClass;
  b.addEventListener("click", onClick);
  return b;
}

function renderModelList() {
  els.modelList.innerHTML = "";
  if (!state.models.length) {
    els.modelList.innerHTML = '<div class="model-empty">还没有模型，点下面按钮添加一个。</div>';
    return;
  }

  for (const m of state.models) {
    const item = document.createElement("div");
    item.className = "model-item" + (m.id === state.modelId ? " active" : "");

    const head = document.createElement("div");
    head.className = "mi-head";
    head.innerHTML =
      `<span class="mi-label">${escapeHtml(m.label)}</span>` +
      `<span class="badge ${m.available ? "ok" : "no"}">${m.available ? "已配置" : "无 key"}</span>`;

    const sub = document.createElement("div");
    sub.className = "mi-sub";
    sub.textContent = `${m.provider} · ${m.model} · ${m.id}`;

    const actions = document.createElement("div");
    actions.className = "mi-actions";
    actions.appendChild(actionButton("编辑", () => openForm(m)));
    actions.appendChild(actionButton("测试", () => testModel(m, actions)));
    if (m.editable) actions.appendChild(actionButton("删除", () => removeModel(m), "danger"));

    item.append(head, sub, actions);
    els.modelList.appendChild(item);
  }
}

function openForm(m) {
  editingId = m?.id ?? null;
  els.formTitle.textContent = m ? `编辑「${m.label}」` : "添加模型";
  els.f.label.value = m?.label ?? "";
  els.f.provider.value = m?.provider ?? "";
  els.f.baseurl.value = m?.baseUrl ?? "";
  els.f.model.value = m?.model ?? "";
  els.f.id.value = m?.id ?? "";
  els.f.id.disabled = Boolean(m);
  els.f.key.value = "";
  els.f.key.placeholder = m?.hasKey ? "已配置，留空则不修改" : "sk-...";
  els.f.nokey.checked = m ? !m.requiresKey : false;
  els.formNote.textContent = "";
  els.formNote.className = "form-note";
  els.modelForm.hidden = false;
  els.f.label.focus();
  els.settings.scrollTop = els.settings.scrollHeight;
}

function closeForm() {
  els.modelForm.hidden = true;
  els.f.id.disabled = false;
  editingId = null;
}

async function saveForm(event) {
  event.preventDefault();
  const model = els.f.model.value.trim();
  const id = els.f.id.value.trim() || slugify(model || els.f.label.value);

  const payload = {
    id,
    label: els.f.label.value.trim() || id,
    provider: els.f.provider.value.trim(),
    baseUrl: els.f.baseurl.value.trim(),
    model,
    requiresKey: !els.f.nokey.checked,
  };
  const key = els.f.key.value.trim();
  if (key) payload.apiKey = key;

  els.formNote.className = "form-note";
  els.formNote.textContent = "保存中…";

  try {
    const res = await fetch("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    state.modelId = payload.id;
    localStorage.setItem("tsagent.model", payload.id);
    await loadModels();
    els.formNote.className = "form-note ok";
    els.formNote.textContent = "已保存";
    setStatus(`模型 ${payload.label} 已保存`);
    setTimeout(closeForm, 700);
  } catch (err) {
    els.formNote.className = "form-note";
    els.formNote.textContent = err.message;
  }
}

async function removeModel(m) {
  if (!window.confirm(`删除模型「${m.label}」？`)) return;
  try {
    const res = await fetch(`/api/models/${encodeURIComponent(m.id)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (state.modelId === m.id) state.modelId = null;
    await loadModels();
    setStatus(`已删除 ${m.label}`);
  } catch (err) {
    setStatus(`删除失败：${err.message}`, true);
  }
}

async function testModel(m, container) {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "测试");
  if (btn) {
    btn.textContent = "测试中…";
    btn.disabled = true;
  }
  setStatus(`正在测试 ${m.label}…`);
  try {
    const res = await fetch(`/api/models/${encodeURIComponent(m.id)}/test`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setStatus(`✓ ${m.label} 连接正常 · ${data.ms} ms${data.sample ? ` · "${data.sample}"` : ""}`);
  } catch (err) {
    setStatus(`✗ ${m.label} 测试失败：${err.message}`, true);
  } finally {
    if (btn) {
      btn.textContent = "测试";
      btn.disabled = false;
    }
  }
}

/* ---------------- rendering ---------------- */

function hideEmpty() {
  if (els.empty && !els.empty.hidden) els.empty.hidden = true;
}

function timeLabel(ms) {
  if (!ms) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function addUserMessage(text) {
  hideEmpty();
  const el = document.createElement("div");
  el.className = "msg user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  el.appendChild(bubble);
  els.messages.appendChild(el);
  scrollToBottom(true);
}

function toolArgsText(args) {
  const entries = Object.entries(args ?? {});
  if (!entries.length) return "";
  const priority = ["command", "path", "pattern", "query", "url", "name"];
  const hit = entries.find(([k]) => priority.includes(k));
  if (hit) return `${hit[0]}: ${String(hit[1])}`;
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("  ")
    .slice(0, 160);
}

function addAssistantMessage() {
  hideEmpty();

  const el = document.createElement("div");
  el.className = "msg assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const body = document.createElement("div");
  body.className = "body";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.hidden = true;

  bubble.append(body, meta);
  el.appendChild(bubble);
  els.messages.appendChild(el);
  scrollToBottom(true);

  // Shown until the first token arrives, so the turn never looks dead.
  const typing = document.createElement("div");
  typing.className = "seg typing";
  typing.innerHTML = "<span></span><span></span><span></span>";
  body.appendChild(typing);

  const view = {
    el,
    body,
    meta,
    text: "",
    seg: null,
    cards: [],
    frame: 0,
    dirty: false,

    append(chunk) {
      if (typing.parentNode) typing.remove();

      if (!view.seg) {
        view.seg = document.createElement("div");
        view.seg.className = "seg text";
        body.appendChild(view.seg);
      }
      view.text += chunk;
      view.dirty = true;

      // Coalesce chunks into one render per frame instead of one per token.
      if (!view.frame) {
        view.frame = requestAnimationFrame(() => {
          view.frame = 0;
          if (!view.seg || !view.dirty) return;
          view.dirty = false;
          view.seg.innerHTML = mdToHtml(view.text) + ' <span class="cursor"></span>';
          scrollToBottom();
        });
      }
    },

    finishText() {
      if (view.frame) {
        cancelAnimationFrame(view.frame);
        view.frame = 0;
      }
      if (typing.parentNode) typing.remove();
      if (!view.seg) return;
      view.seg.innerHTML = mdToHtml(view.text);
      view.seg = null;
      view.text = "";
      view.dirty = false;
    },

    addTool(name, args) {
      view.finishText();
      const card = document.createElement("div");
      card.className = "seg tool running";
      card.innerHTML =
        `<div class="tool-head"><span class="tool-name">${escapeHtml(name)}</span>` +
        `<span class="tool-state">运行中…</span></div>` +
        `<div class="tool-args">${escapeHtml(toolArgsText(args))}</div>` +
        `<div class="tool-out" hidden></div>`;
      body.appendChild(card);
      view.cards.push({ name, card, done: false });
      scrollToBottom();
    },

    completeTool(name, ok, preview) {
      const entry = view.cards.find((c) => c.name === name && !c.done);
      if (!entry) return;
      entry.done = true;
      entry.card.classList.remove("running");
      entry.card.classList.add(ok ? "ok" : "err");
      entry.card.querySelector(".tool-state").textContent = ok ? "完成" : "失败";
      const out = entry.card.querySelector(".tool-out");
      if (preview) {
        out.hidden = false;
        out.textContent = preview.length > 600 ? `${preview.slice(0, 600)}…` : preview;
      }
      scrollToBottom();
    },

    addApproval(id, action, detail) {
      view.finishText();
      const card = document.createElement("div");
      card.className = "seg approval";
      card.innerHTML =
        `<div class="approval-title">需要你确认</div>` +
        `<div class="approval-action">${escapeHtml(action)}</div>` +
        (detail ? `<pre class="approval-code">${escapeHtml(detail)}</pre>` : "") +
        `<div class="approval-actions"></div>`;

      const actions = card.querySelector(".approval-actions");
      const allow = document.createElement("button");
      allow.type = "button";
      allow.className = "primary";
      allow.textContent = "允许";
      const deny = document.createElement("button");
      deny.type = "button";
      deny.className = "ghost";
      deny.textContent = "拒绝";

      const decide = async (approved) => {
        allow.disabled = true;
        deny.disabled = true;
        try {
          await fetch("/api/chat/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approvalId: id, approved }),
          });
        } catch {
          /* the run may already be gone */
        }
        actions.innerHTML = `<span class="approval-result ${approved ? "ok" : "no"}">${
          approved ? "已允许" : "已拒绝"
        }</span>`;
      };

      allow.addEventListener("click", () => decide(true));
      deny.addEventListener("click", () => decide(false));
      actions.append(allow, deny);
      body.appendChild(card);
      scrollToBottom();
    },

    finalize(label, ms, chars) {
      view.finishText();
      if (chars === 0) {
        body.insertAdjacentHTML("beforeend", '<div class="seg text empty">（没有文本输出）</div>');
      }
      meta.hidden = false;
      meta.innerHTML =
        `<span>${escapeHtml(label || "")}</span>` +
        (timeLabel(ms) ? `<span>${timeLabel(ms)}</span>` : "") +
        `<span>${chars} 字</span>`;
      view.sealButton = document.createElement("button");
      view.sealButton.textContent = "复制";
      view.sealButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(view.el.innerText.trim());
          view.sealButton.textContent = "已复制";
          setTimeout(() => (view.sealButton.textContent = "复制"), 1500);
        } catch {
          view.sealButton.textContent = "复制失败";
        }
      });
      meta.appendChild(view.sealButton);
    },

    fail(message) {
      view.finishText();
      const box = document.createElement("div");
      box.className = "seg text error-text";
      box.textContent = message;
      body.appendChild(box);
      meta.hidden = true;
      scrollToBottom();
    },
  };

  return view;
}

function addErrorMessage(message) {
  hideEmpty();
  const el = document.createElement("div");
  el.className = "msg assistant error";
  el.innerHTML = `<div class="bubble">${escapeHtml(message)}</div>`;
  els.messages.appendChild(el);
  scrollToBottom(true);
}

/* ---------------- streaming ---------------- */

async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        onEvent(parsed);
      }
    }
  }
}

function setStreaming(on) {
  state.streaming = on;
  els.send.hidden = on;
  els.stop.hidden = !on;
  els.send.disabled = on;
}

function newSessionId(id) {
  state.sessionId = id;
  if (id) localStorage.setItem("tsagent.session", id);
  else localStorage.removeItem("tsagent.session");
}

async function sendMessage(text) {
  if (state.streaming) return;
  if (!state.modelId) {
    setStatus("先选择一个模型", true);
    return;
  }

  addUserMessage(text);
  const view = addAssistantMessage();

  const model = state.models.find((m) => m.id === state.modelId);
  const started = Date.now();
  let chars = 0;

  setStreaming(true);
  setStatus("生成中…");
  state.controller = new AbortController();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        modelId: state.modelId,
        message: text,
        system: state.system,
        temperature: state.temperature,
      }),
      signal: state.controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    await readSSE(res, (evt) => {
      switch (evt.type) {
        case "start":
          if (evt.sessionId) newSessionId(evt.sessionId);
          break;
        case "delta":
          chars += evt.text.length;
          view.append(evt.text);
          setStatus("生成中…");
          break;
        case "tool_start":
          view.addTool(evt.name, evt.args);
          setStatus(`调用工具 ${evt.name}…`);
          break;
        case "tool_end":
          view.completeTool(evt.name, evt.ok, evt.preview ?? "");
          break;
        case "approval":
          view.addApproval(evt.approvalId, evt.action, evt.detail);
          setStatus("等待你确认…");
          break;
        case "approval_timeout":
          setStatus("审批超时，已自动拒绝", true);
          break;
        case "done":
          view.finalize(model?.label ?? state.modelId, evt.ms ?? Date.now() - started, chars);
          setStatus("");
          break;
        case "error":
          throw new Error(evt.message || "生成失败");
        default:
          break;
      }
    });
  } catch (err) {
    if (err.name === "AbortError") {
      view.finishText();
      setStatus("已停止");
    } else {
      view.fail(err.message);
      setStatus(err.message, true);
    }
  } finally {
    setStreaming(false);
    state.controller = null;
    els.input.focus();
  }
}

/* ---------------- sessions ---------------- */

function renderHistory(messages) {
  els.messages.querySelectorAll(".msg").forEach((node) => node.remove());
  let shown = 0;

  for (const m of messages) {
    if (m.role === "user" && m.content) {
      addUserMessage(m.content);
      shown++;
    } else if (m.role === "assistant" && m.content) {
      const view = addAssistantMessage();
      view.append(m.content);
      view.finishText();
      shown++;
    }
  }

  if (els.empty) els.empty.hidden = shown > 0;
  if (!shown && els.empty) els.messages.appendChild(els.empty);
  scrollToBottom(true);
}

async function loadSession(id) {
  if (!id) return false;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (!res.ok) return false;
    const data = await res.json();
    renderHistory(data.messages ?? []);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- events ---------------- */

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
}

els.input.addEventListener("input", autoGrow);

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

els.send.addEventListener("click", submit);

function submit() {
  const text = els.input.value.trim();
  if (!text || state.streaming) return;
  els.input.value = "";
  autoGrow();
  sendMessage(text);
}

els.stop.addEventListener("click", () => state.controller?.abort());

els.clear.addEventListener("click", async () => {
  if (state.streaming) state.controller?.abort();
  try {
    const res = await fetch("/api/sessions", { method: "POST" });
    const data = await res.json();
    newSessionId(data.id);
  } catch {
    newSessionId(null);
  }
  els.messages.innerHTML = "";
  if (els.empty) {
    els.empty.hidden = false;
    els.messages.appendChild(els.empty);
  }
  setStatus("");
});

els.model.addEventListener("change", () => {
  state.modelId = els.model.value;
  localStorage.setItem("tsagent.model", state.modelId);
  updateModelDetail();
  renderModelList();
});

els.modelForm.addEventListener("submit", saveForm);
els.cancelForm.addEventListener("click", closeForm);
els.addModel.addEventListener("click", () => openForm(null));
els.f.model.addEventListener("blur", () => {
  if (!editingId && !els.f.id.value.trim() && els.f.model.value.trim()) {
    els.f.id.value = slugify(els.f.model.value);
  }
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => {
      p.hidden = p.dataset.panel !== tab.dataset.tab;
    });
  });
});

$("#btn-settings").addEventListener("click", () => {
  els.settings.hidden = false;
  els.system.focus();
});

$("#btn-close-settings").addEventListener("click", () => (els.settings.hidden = true));

els.temperature.addEventListener("input", () => {
  state.temperature = Number(els.temperature.value);
  els.tempValue.textContent = state.temperature.toFixed(1);
  localStorage.setItem("tsagent.temperature", String(state.temperature));
});

els.system.addEventListener("input", () => {
  state.system = els.system.value;
  localStorage.setItem("tsagent.system", state.system);
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    els.input.value = chip.dataset.prompt ?? "";
    els.input.focus();
    autoGrow();
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.settings.hidden) els.settings.hidden = true;
});

/* ---------------- boot ---------------- */

(async function boot() {
  const savedSystem = localStorage.getItem("tsagent.system");
  if (savedSystem) {
    state.system = savedSystem;
    els.system.value = savedSystem;
  }

  const savedTemp = Number(localStorage.getItem("tsagent.temperature"));
  if (Number.isFinite(savedTemp) && savedTemp > 0) {
    state.temperature = savedTemp;
    els.temperature.value = String(savedTemp);
    els.tempValue.textContent = savedTemp.toFixed(1);
  }

  await loadModels();

  const savedSession = localStorage.getItem("tsagent.session");
  if (savedSession) {
    state.sessionId = savedSession;
    const restored = await loadSession(savedSession);
    if (restored) setStatus("已恢复上次会话");
  }

  els.input.focus();
})();
