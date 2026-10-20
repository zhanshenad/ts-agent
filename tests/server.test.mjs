/**
 * Web gateway + agent smoke test: mock upstream LLM, real dist/server.js.
 * `npm run test:web`
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "server.js");

const REPLY = "Hello from mock!";
const TOOL_REPLY = "Tool finished.";
const seen = { toolCount: 0, sawTools: false };

/* ---------- mock upstream ---------- */

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    assert.equal(req.url, "/v1/chat/completions");
    assert.ok(Array.isArray(body.messages) && body.messages.length > 0);

    if (Array.isArray(body.tools) && body.tools.length) {
      seen.sawTools = true;
      seen.toolCount = body.tools.length;
    }

    const wantsTool = body.messages.some(
      (m) => m.role === "user" && /run a command/i.test(m.content ?? ""),
    );
    const hasToolResult = body.messages.some((m) => m.role === "tool");

    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });

      if (wantsTool && !hasToolResult) {
        sse(res, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_shell_1",
                    type: "function",
                    function: {
                      name: "shell",
                      arguments: JSON.stringify({ command: "echo agent-tool-ok" }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const text = wantsTool && hasToolResult ? TOOL_REPLY : REPLY;
      for (const piece of text.match(/.{1,6}/g) ?? []) {
        sse(res, { choices: [{ delta: { content: piece }, finish_reason: null }] });
      }
      sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: REPLY }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    );
  });
});

/* ---------- helpers ---------- */

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /http:\/\/[\d.]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => reject(new Error(`server exited early (${code}):\n${out}`)));
  });
}

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
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") onEvent(JSON.parse(payload));
        }
      }
    }
  }
}

async function chat(base, body) {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ---------- test ---------- */

async function main() {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsagent-web-"));
  const modelsFile = path.join(tmpDir, "models.json");
  fs.writeFileSync(
    modelsFile,
    JSON.stringify({
      models: [
        {
          id: "mock-fast",
          label: "Mock Fast",
          provider: "Test",
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          model: "mock-1",
          apiKey: "test-key",
        },
      ],
    }),
  );

  const localFile = path.join(tmpDir, "models.local.json");
  const stateDir = path.join(tmpDir, ".tsagent");

  const child = spawn(process.execPath, [entry, "--port", "0"], {
    cwd: root,
    env: {
      ...process.env,
      TSA_MODELS_FILE: modelsFile,
      TSA_MODELS_LOCAL_FILE: localFile,
      TSA_STATE_DIR: stateDir,
      NO_COLOR: "1",
    },
  });

  try {
    const base = await waitForUrl(child);

    // 1. health + model list
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.models, 1);

    const catalog = await (await fetch(`${base}/api/models`)).json();
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].available, true);
    assert.equal(catalog.models[0].apiKey, undefined, "key must never reach the browser");

    // 2. chat UI is served
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /TsAgent/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/style.css`)).status, 200);

    // 3. one agent turn (no tools): streaming + persisted session
    const chatRes = await chat(base, {
      modelId: "mock-fast",
      message: "hi there",
      system: "be brief",
      temperature: 0.2,
    });
    assert.equal(chatRes.status, 200);
    assert.match(chatRes.headers.get("content-type"), /text\/event-stream/);

    let sessionId = null;
    let text = "";
    let donePayload = null;
    await readSSE(chatRes, (evt) => {
      if (evt.type === "start") sessionId = evt.sessionId;
      else if (evt.type === "delta") text += evt.text;
      else if (evt.type === "done") donePayload = evt;
      else if (evt.type === "error") throw new Error(evt.message);
    });
    assert.ok(sessionId, "start frame must carry a sessionId");
    assert.equal(text, REPLY);
    assert.equal(donePayload.chars, REPLY.length);
    assert.equal(donePayload.sessionId, sessionId);

    // tools are advertised to the model
    assert.ok(seen.sawTools && seen.toolCount >= 10, `expected agent tools, got ${seen.toolCount}`);

    // session on disk + readable through the API
    const stored = await (await fetch(`${base}/api/sessions/${sessionId}`)).json();
    assert.equal(stored.id, sessionId);
    const roles = stored.messages.map((m) => m.role);
    assert.ok(roles.includes("system"), "system prompt should be stored");
    assert.ok(roles.includes("user"), "user turn should be stored");
    assert.ok(roles.includes("assistant"), "assistant turn should be stored");
    assert.ok(
      stored.messages.some((m) => m.role === "assistant" && m.content === REPLY),
      "assistant answer should be persisted",
    );
    assert.ok(
      stored.messages[0].content.includes("be brief"),
      "custom system prompt should be appended",
    );

    // 4. tool call + approval round trip
    const toolRes = await chat(base, { modelId: "mock-fast", message: "run a command please" });
    assert.equal(toolRes.status, 200);

    let sawApproval = false;
    let toolText = "";
    await readSSE(toolRes, (evt) => {
      if (evt.type === "tool_start") assert.equal(evt.name, "shell");
      if (evt.type === "approval") {
        sawApproval = true;
        void fetch(`${base}/api/chat/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approvalId: evt.approvalId, approved: true }),
        });
      }
      if (evt.type === "delta") toolText += evt.text;
    });
    assert.ok(sawApproval, "shell must request approval");
    assert.equal(toolText, TOOL_REPLY);

    // 5. OpenAI-compatible facade stays a plain chat endpoint
    const oa = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-fast", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(oa.status, 200);
    const oaJson = await oa.json();
    assert.equal(oaJson.object, "chat.completion");
    assert.equal(oaJson.choices[0].message.content, REPLY);
    assert.equal(oaJson.usage.total_tokens, 7);

    const oaStream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-fast",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert.equal(oaStream.status, 200);
    const raw = await oaStream.text();
    assert.ok(raw.includes("[DONE]"));
    let streamed = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      streamed += JSON.parse(payload).choices?.[0]?.delta?.content ?? "";
    }
    assert.equal(streamed, REPLY);

    // 6. validation
    const badModel = await chat(base, { modelId: "nope", message: "hi" });
    assert.equal(badModel.status, 404);

    const emptyMessage = await chat(base, { modelId: "mock-fast", message: "   " });
    assert.equal(emptyMessage.status, 400);

    const missingSession = await fetch(`${base}/api/sessions/does-not-exist`);
    assert.equal(missingSession.status, 404);

    // 7. model management from the web UI
    const created = await fetch(`${base}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "web-added",
        label: "Web Added",
        provider: "Test",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: "mock-2",
        apiKey: "sk-secret-value",
      }),
    });
    assert.equal(created.status, 200, await created.text());

    const afterAdd = await (await fetch(`${base}/api/models`)).json();
    const added = afterAdd.models.find((m) => m.id === "web-added");
    assert.ok(added);
    assert.equal(added.available, true);
    assert.equal(added.editable, true);
    assert.ok(!JSON.stringify(afterAdd).includes("sk-secret-value"), "key must not leak");

    const storedKey = JSON.parse(fs.readFileSync(localFile, "utf8"));
    assert.equal(
      storedKey.models.find((m) => m.id === "web-added").apiKey,
      "sk-secret-value",
    );

    const edited = await fetch(`${base}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "web-added",
        label: "Web Added v2",
        provider: "Test",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: "mock-2",
      }),
    });
    assert.equal(edited.status, 200);
    const afterEdit = await (await fetch(`${base}/api/models`)).json();
    const editedModel = afterEdit.models.find((m) => m.id === "web-added");
    assert.equal(editedModel.label, "Web Added v2");
    assert.equal(editedModel.available, true, "key survives an edit without apiKey");

    const tested = await fetch(`${base}/api/models/web-added/test`, { method: "POST" });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).ok, true);

    const badUrl = await fetch(`${base}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad", baseUrl: "ftp://x", model: "m" }),
    });
    assert.equal(badUrl.status, 400);

    const del = await fetch(`${base}/api/models/web-added`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.ok(
      !(await (await fetch(`${base}/api/models`)).json()).models.some((m) => m.id === "web-added"),
    );

    console.log("\n✅ web gateway + agent tests passed");
    console.log(`   upstream : ${upstreamPort}`);
    console.log(`   gateway  : ${base}`);
    console.log(`   session  : ${sessionId}`);
  } finally {
    child.kill();
    upstream.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n❌ web gateway test failed:", err);
  upstream.close();
  process.exit(1);
});
