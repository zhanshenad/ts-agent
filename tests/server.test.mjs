/**
 * Web gateway smoke test: mock upstream LLM, real dist/server.js.
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

/* ---------- mock upstream ---------- */

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    assert.equal(req.url, "/v1/chat/completions");
    assert.ok(Array.isArray(body.messages) && body.messages.length > 0);

    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of ["Hello", " from", " mock!"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
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

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
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

  const child = spawn(process.execPath, [entry, "--port", "0"], {
    cwd: root,
    env: {
      ...process.env,
      TSA_MODELS_FILE: modelsFile,
      TSA_MODELS_LOCAL_FILE: localFile,
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
    assert.equal(catalog.models[0].id, "mock-fast");
    assert.equal(catalog.models[0].available, true, "model with inline key must be available");
    assert.equal(catalog.models[0].apiKey, undefined, "key must never reach the browser");

    // 2. chat UI is served
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /TsAgent/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/style.css`)).status, 200);

    // 3. streaming /api/chat
    const chat = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: "mock-fast",
        messages: [{ role: "user", content: "hi" }],
        system: "be brief",
        temperature: 0.2,
      }),
    });
    assert.equal(chat.status, 200);
    assert.match(chat.headers.get("content-type"), /text\/event-stream/);

    let text = "";
    let donePayload = null;
    let started = false;
    await readSSE(chat, (evt) => {
      if (evt.type === "start") started = true;
      else if (evt.type === "delta") text += evt.text;
      else if (evt.type === "done") donePayload = evt;
      else if (evt.type === "error") throw new Error(evt.message);
    });
    assert.ok(started, "should emit a start frame");
    assert.equal(text, REPLY);
    assert.ok(donePayload && donePayload.chars === REPLY.length, "done frame should report length");

    // 4. OpenAI-compatible non-streaming
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

    // 5. OpenAI-compatible streaming
    const oaStream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-fast", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(oaStream.status, 200);
    let streamed = "";
    let sawDone = false;
    const raw = await oaStream.text();
    assert.ok(raw.includes("[DONE]"), "stream should terminate with [DONE]");
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        sawDone = true;
        continue;
      }
      const json = JSON.parse(payload);
      streamed += json.choices?.[0]?.delta?.content ?? "";
    }
    assert.ok(sawDone);
    assert.equal(streamed, REPLY);

    // 6. validation + errors
    const badModel = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "nope", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(badModel.status, 404);

    const badRole = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "mock-fast", messages: [{ role: "tool", content: "x" }] }),
    });
    assert.equal(badRole.status, 400);

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
    assert.ok(added, "new model should be listed");
    assert.equal(added.available, true);
    assert.equal(added.editable, true);
    assert.equal(added.apiKey, undefined, "API must never return the key");

    const rawList = JSON.stringify(afterAdd);
    assert.ok(!rawList.includes("sk-secret-value"), "key must not leak in the model list");

    // persisted to disk, plaintext, only on the server
    const stored = JSON.parse(fs.readFileSync(localFile, "utf8"));
    assert.equal(stored.models.find((m) => m.id === "web-added").apiKey, "sk-secret-value");

    // editing without apiKey keeps the stored key
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
    assert.equal(editedModel.available, true, "key should survive an edit that omits apiKey");

    // connection test hits the mock upstream
    const tested = await fetch(`${base}/api/models/web-added/test`, { method: "POST" });
    assert.equal(tested.status, 200);
    const testJson = await tested.json();
    assert.equal(testJson.ok, true);

    // invalid input is rejected
    const badUrl = await fetch(`${base}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad", baseUrl: "ftp://x", model: "m" }),
    });
    assert.equal(badUrl.status, 400);

    const badId = await fetch(`${base}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "has spaces!", baseUrl: "https://x/v1", model: "m" }),
    });
    assert.equal(badId.status, 400);

    // delete removes it from the catalogue
    const del = await fetch(`${base}/api/models/web-added`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const afterDelete = await (await fetch(`${base}/api/models`)).json();
    assert.ok(!afterDelete.models.some((m) => m.id === "web-added"));

    const delMissing = await fetch(`${base}/api/models/does-not-exist`, { method: "DELETE" });
    assert.equal(delMissing.status, 404);

    console.log("\n✅ web gateway tests passed");
    console.log(`   upstream : ${upstreamPort}`);
    console.log(`   gateway  : ${base}`);
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
