#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Agent } from "./agent.js";
import type { Config } from "./config.js";
import { chatCompletion, chatCompletionStream, describeLlmError, LLMError } from "./llm.js";
import {
  deleteLocalModel,
  findModel,
  loadEnv,
  loadModels,
  localModelsFile,
  resolveApiKey,
  toPublic,
  upsertLocalModel,
  validateModelInput,
  type ModelEntry,
} from "./models.js";
import { buildSystemPrompt } from "./prompt.js";
import { SessionStore } from "./session.js";
import { scanSkills } from "./skills.js";
import { createToolRegistry } from "./tools/index.js";
import type { ChatMessage } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
/** Sessions / skills / memory live here. Tests point this at a temp dir. */
const STATE_DIR = process.env.TSA_STATE_DIR
  ? path.resolve(process.env.TSA_STATE_DIR)
  : path.join(ROOT, ".tsagent");
const MAX_BODY = 1_000_000;
const MAX_MESSAGES = 200;
const MAX_CONTENT = 100_000;

interface ServerArgs {
  port: number;
  host: string;
}

function parseServerArgs(argv: string[]): ServerArgs {
  const args: ServerArgs = {
    port: Number(process.env.TSA_PORT ?? "8787"),
    host: process.env.TSA_HOST ?? "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port" || a === "-p") args.port = Number(argv[++i] ?? args.port);
    else if (a === "--host") args.host = argv[++i] ?? args.host;
    else if (a === "--help" || a === "-h") {
      console.log(`ts-agent web gateway

Usage: node dist/server.js [--port 8787] [--host 127.0.0.1]

Endpoints
  GET  /                       chat UI
  GET  /api/models             available models
  POST /api/chat               SSE chat  { modelId, messages, system?, temperature? }
  POST /v1/chat/completions    OpenAI-compatible (stream: true|false)
  GET  /api/health

Config
  models.json                  model catalog (apiKeyEnv points at an env var)
  .env / process.env           provider keys`);
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.port)) args.port = 8787;
  return args;
}

const env = loadEnv(ROOT);
const getCatalog = () => loadModels(ROOT);

function configFor(entry: ModelEntry, temperature?: number): Config {
  const key = resolveApiKey(entry, env);
  return {
    baseUrl: entry.baseUrl,
    // Local runtimes (Ollama/vLLM) need no key; send a placeholder so the
    // request still goes out instead of failing the "missing key" guard.
    apiKey: key || (entry.requiresKey === false ? "local-no-key" : ""),
    model: entry.model,
    temperature: temperature ?? entry.temperature ?? 0.7,
    maxIterations: Number(process.env.TSA_MAX_ITERATIONS ?? "12") || 12,
    maxTokens: undefined,
    workspace: ROOT,
    homeDir: STATE_DIR,
    autoApprove: false,
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large (limit 1 MB)"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new Error("messages must be an array");
  if (raw.length > MAX_MESSAGES) throw new Error(`Too many messages (max ${MAX_MESSAGES})`);
  const out: ChatMessage[] = [];
  for (const item of raw) {
    const m = item as { role?: unknown; content?: unknown };
    const role = String(m.role ?? "");
    if (!["system", "user", "assistant"].includes(role)) {
      throw new Error(`Invalid role "${role}"`);
    }
    const content = typeof m.content === "string" ? m.content : "";
    if (content.length > MAX_CONTENT) throw new Error("Message too long");
    if (!content.trim()) continue;
    out.push({ role: role as ChatMessage["role"], content });
  }
  if (!out.length) throw new Error("messages is empty");
  return out;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/* ---------------- agent runtime for the web UI ---------------- */

const sessionStore = new SessionStore(path.join(STATE_DIR, "sessions"));
const agentSkills = scanSkills(path.join(STATE_DIR, "skills"));
/** Tools are stateless — build the registry once, share it across requests. */
const webTools = createToolRegistry({ skills: agentSkills, allowSubagent: false });
const approvals = new Map<string, (approved: boolean) => void>();
const busySessions = new Set<string>();
const APPROVAL_TIMEOUT_MS = Number(process.env.TSA_APPROVAL_TIMEOUT_MS ?? "120000") || 120_000;

type Emit = (event: unknown) => void;

/** Ask the browser to approve a destructive tool call; resolves on its answer. */
function requestApproval(
  emit: Emit,
  action: string,
  detail?: string,
  track?: Set<string>,
): Promise<boolean> {
  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    const done = (approved: boolean): void => {
      track?.delete(id);
      approvals.delete(id);
      resolve(approved);
    };

    const timer = setTimeout(() => {
      emit({ type: "approval_timeout", approvalId: id });
      done(false);
    }, APPROVAL_TIMEOUT_MS);

    approvals.set(id, (approved) => {
      clearTimeout(timer);
      done(approved);
    });
    track?.add(id);

    emit({ type: "approval", approvalId: id, action, detail: detail ?? "" });
  });
}

/** POST /api/chat/approve — the browser's answer to an approval prompt. */
async function handleApprove(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: { approvalId?: string; approved?: boolean };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "请求体不是合法 JSON" });
    return;
  }

  const id = String(body.approvalId ?? "");
  const resolve = approvals.get(id);
  if (!resolve) {
    json(res, 404, { error: "审批请求已失效或已超时" });
    return;
  }

  approvals.delete(id);
  resolve(body.approved === true);
  json(res, 200, { ok: true });
}

/**
 * POST /api/chat — one full agent turn: model → tools → model …,
 * with skills, memory and session persistence.
 */
async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let payload: {
    sessionId?: string;
    modelId?: string;
    message?: string;
    system?: string;
    temperature?: number;
  };
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    json(res, 400, { error: `请求体不是合法 JSON：${(err as Error).message}` });
    return;
  }

  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) {
    json(res, 400, { error: "message 不能为空" });
    return;
  }
  if (message.length > MAX_CONTENT) {
    json(res, 400, { error: "消息过长" });
    return;
  }

  const entry = findModel(getCatalog().entries, String(payload.modelId ?? ""));
  if (!entry) {
    json(res, 404, { error: `未知模型 "${payload.modelId}"` });
    return;
  }

  const cfg = configFor(
    entry,
    typeof payload.temperature === "number" ? payload.temperature : undefined,
  );
  if (!cfg.apiKey && entry.requiresKey !== false) {
    json(res, 400, {
      error: `模型 ${entry.label} 未配置 API key（可设 ${entry.apiKeyEnv ?? "key"}，或在网页 ⚙ → 模型 里填写）`,
    });
    return;
  }

  const existing = payload.sessionId ? sessionStore.load(String(payload.sessionId)) : undefined;
  const session = existing ?? sessionStore.create();
  if (!existing) sessionStore.save(session);

  if (busySessions.has(session.id)) {
    json(res, 409, { error: "该会话正在生成中，请稍候或先点停止" });
    return;
  }
  busySessions.add(session.id);

  const customSystem =
    typeof payload.system === "string" ? payload.system.trim().slice(0, MAX_CONTENT) : "";

  const controller = new AbortController();
  const myApprovals = new Set<string>();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
    // Tab is gone: nobody can answer these prompts, release them now
    // instead of holding the session lock for the full timeout.
    for (const id of myApprovals) {
      const resolve = approvals.get(id);
      if (resolve) {
        approvals.delete(id);
        resolve(false);
      }
    }
    myApprovals.clear();
  });

  res.writeHead(200, { ...SSE_HEADERS, "x-model": entry.id, "x-session": session.id });
  const send: Emit = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  send({
    type: "start",
    sessionId: session.id,
    model: entry.id,
    provider: entry.provider ?? "custom",
  });

  const started = Date.now();
  let chars = 0;

  const agent = new Agent({
    config: cfg,
    tools: webTools,
    session,
    store: sessionStore,
    buildSystemPrompt: () => {
      const base = buildSystemPrompt({ config: cfg, skills: agentSkills });
      return customSystem ? `${base}\n\n## 用户附加要求\n${customSystem}` : base;
    },
    hooks: {
      onAssistantText: () => {},
      onToolStart: (name, args) => send({ type: "tool_start", name, args }),
      onToolEnd: (name, result) =>
        send({
          type: "tool_end",
          name,
          ok: !result.isError,
          preview: result.content.slice(0, 800),
        }),
      onIteration: (index) => send({ type: "iteration", index }),
    },
    approve: ({ action, detail }) => requestApproval(send, action, detail, myApprovals),
    signal: () => controller.signal,
  });

  try {
    const answer = await agent.run(message, (delta) => {
      chars += delta.length;
      send({ type: "delta", text: delta });
    });
    send({
      type: "done",
      sessionId: session.id,
      chars,
      ms: Date.now() - started,
      answer: answer.slice(0, 200),
    });
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    send({
      type: "error",
      message: aborted ? "已停止" : describeLlmError(err),
      aborted,
    });
    if (err instanceof LLMError && err.status) {
      console.error(`[chat] ${entry.id}: HTTP ${err.status}`);
    }
  } finally {
    busySessions.delete(session.id);
    if (!res.writableEnded) res.end();
  }
}

/** POST /v1/chat/completions ?OpenAI-compatible facade. */
async function handleOpenAI(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: {
    model?: string;
    messages?: unknown;
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
  };
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    json(res, 400, { error: { message: (err as Error).message, type: "invalid_request_error" } });
    return;
  }

  const entry = findModel(getCatalog().entries, String(body.model ?? ""));
  if (!entry) {
    json(res, 404, {
      error: {
        message: `Unknown model "${body.model}". GET /api/models for the list.`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  let messages: ChatMessage[];
  try {
    messages = sanitizeMessages(body.messages);
  } catch (err) {
    json(res, 400, { error: { message: (err as Error).message, type: "invalid_request_error" } });
    return;
  }

  const cfg = configFor(entry, typeof body.temperature === "number" ? body.temperature : undefined);
  if (!cfg.apiKey && entry.requiresKey !== false) {
    json(res, 400, {
      error: { message: `No API key configured for ${entry.label}`, type: "authentication_error" },
    });
    return;
  }

  const controller = new AbortController();
  const myApprovals = new Set<string>();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
    // Tab is gone: nobody can answer these prompts, release them now
    // instead of holding the session lock for the full timeout.
    for (const id of myApprovals) {
      const resolve = approvals.get(id);
      if (resolve) {
        approvals.delete(id);
        resolve(false);
      }
    }
    myApprovals.clear();
  });

  try {
    if (body.stream) {
      res.writeHead(200, SSE_HEADERS);
      for await (const event of chatCompletionStream(cfg, messages, { signal: controller.signal })) {
        if (res.writableEnded) break;
        if (event.type === "text") {
          res.write(
            `data: ${JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              model: entry.model,
              choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
            })}\n\n`,
          );
        } else if (event.type === "done") {
          res.write(
            `data: ${JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              model: entry.model,
              choices: [{ index: 0, delta: {}, finish_reason: event.finishReason ?? "stop" }],
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
        }
      }
      res.end();
      return;
    }

    const result = await chatCompletion(cfg, messages, []);
    json(res, 200, {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: entry.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.content ?? "" },
          finish_reason: result.finishReason ?? "stop",
        },
      ],
      usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const status = err instanceof LLMError && err.status ? 502 : 500;
    json(res, status, { error: { message: (err as Error).message, type: "upstream_error" } });
  }
}

/** POST /api/models — create or update a model; key is write-only. */
async function handleSaveModel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch (err) {
    json(res, 400, { error: `请求体不是合法 JSON：${(err as Error).message}` });
    return;
  }

  let input;
  try {
    input = validateModelInput(body);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
    return;
  }

  try {
    const entry = upsertLocalModel(ROOT, input);
    console.log(`[models] saved ${entry.id} (${entry.model}) key=${entry.apiKey ? "set" : "none"}`);
    json(res, 200, { ok: true, id: entry.id });
  } catch (err) {
    json(res, 500, { error: `写入 ${localModelsFile(ROOT)} 失败：${(err as Error).message}` });
  }
}

/** POST /api/models/:id/test — one tiny call to check the key/baseUrl works. */
async function handleTestModel(id: string, res: http.ServerResponse): Promise<void> {
  const entry = findModel(getCatalog().entries, id);
  if (!entry) {
    json(res, 404, { ok: false, error: `模型 "${id}" 不存在` });
    return;
  }

  const cfg = configFor(entry);
  cfg.maxTokens = 8;
  const started = Date.now();

  try {
    const result = await chatCompletion(cfg, [{ role: "user", content: "ping" }], []);
    json(res, 200, {
      ok: true,
      ms: Date.now() - started,
      sample: (result.content ?? "").slice(0, 60),
    });
  } catch (err) {
    const raw = (err as Error).message;
    const message =
      raw === "fetch failed"
        ? `无法连接到 ${entry.baseUrl}（服务未启动或地址不对）`
        : raw;
    json(res, 502, { ok: false, error: message });
  }
}

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/markdown.mjs": { file: "markdown.mjs", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

function serveStatic(res: http.ServerResponse, pathname: string): boolean {
  const hit = STATIC[pathname];
  if (!hit) return false;
  const file = path.join(PUBLIC_DIR, hit.file);
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      "content-type": hit.type,
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    json(res, 500, { error: `Missing ${hit.file} ?run the build from the project root` });
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  // Local dev server: allow the page to be opened from other ports if needed.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" });
    res.end();
    return;
  }

  if (req.method === "GET") {
    if (pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        models: getCatalog().entries.length,
        source: getCatalog().source,
        busySessions: busySessions.size,
        pendingApprovals: approvals.size,
      });
      return;
    }
    if (pathname === "/api/models") {
      json(res, 200, {
        source: getCatalog().source,
        warnings: getCatalog().warnings,
        store: path.relative(ROOT, localModelsFile(ROOT)).split(path.sep).join("/"),
        models: getCatalog().entries.map((e) => toPublic(e, env)),
      });
      return;
    }
    if (/^\/api\/sessions\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split("/")[3] ?? "");
      const session = sessionStore.load(id);
      if (!session) {
        json(res, 404, { error: `会话 "${id}" 不存在` });
        return;
      }
      json(res, 200, {
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messages: session.messages,
      });
      return;
    }

    if (serveStatic(res, pathname)) return;
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    json(res, 404, { error: "Not found" });
    return;
  }

  if (req.method === "POST" && pathname === "/api/sessions") {
    const session = sessionStore.create();
    sessionStore.save(session);
    json(res, 200, { id: session.id });
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat/approve") {
    void handleApprove(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/models") {
    void handleSaveModel(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    });
    return;
  }

  if (req.method === "POST" && /^\/api\/models\/[^/]+\/test$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split("/")[3] ?? "");
    void handleTestModel(id, res).catch((err) => {
      if (!res.headersSent) json(res, 502, { ok: false, error: (err as Error).message });
    });
    return;
  }

  if (req.method === "DELETE" && /^\/api\/models\/[^/]+$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split("/")[3] ?? "");
    const removed = deleteLocalModel(ROOT, id);
    if (!removed) {
      json(res, 404, { error: `模型 "${id}" 不存在` });
      return;
    }
    console.log(`[models] deleted ${id}`);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    void handleChat(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
      else if (!res.writableEnded) res.end();
    });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/chat/completions") {
    void handleOpenAI(req, res).catch((err) => {
      if (!res.headersSent) {
        json(res, 500, { error: { message: (err as Error).message, type: "server_error" } });
      } else if (!res.writableEnded) res.end();
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

const args = parseServerArgs(process.argv.slice(2));

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${args.port} is already in use. Try: node dist/server.js --port 8788`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(args.port, args.host, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : args.port;
  console.log(`\n  ts-agent web  ->  http://${args.host}:${port}\n`);
  console.log(`  models (${getCatalog().source}):`);
  for (const entry of getCatalog().entries) {
    const pub = toPublic(entry, env);
    console.log(
      `    ${pub.available ? "[ok]" : "[--]"} ${pub.id.padEnd(16)} ${pub.provider.padEnd(10)} ${pub.model}` +
        (pub.available ? "" : `   (${pub.reason})`),
    );
  }
  for (const w of getCatalog().warnings) console.log(`  ! ${w}`);
  if (args.host !== "127.0.0.1" && args.host !== "localhost") {
    console.log(
      `\n  [!] listening on ${args.host} - anyone on the network can spend your API quota.`,
    );
  }
  console.log("\n  press Ctrl+C to stop\n");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
