/**
 * Layer 4 — contract test: the /v1 endpoint must work with the real OpenAI SDK,
 * not just with hand-written fetch calls.
 * `node tests/contract.test.mjs`
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "server.js");

const REPLY = "contract-ok";

const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(body.model, "mock-1", "model name must be passed through as configured");

    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of ["contract", "-ok"]) {
        sse(res, { choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      }
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "mock-1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: REPLY },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
  });
});

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no start:\n${out}`)), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /http:\/\/[\d.]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    child.on("exit", (c) => reject(new Error(`exited ${c}:\n${out}`)));
  });
}

async function main() {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tsagent-contract-"));
  const modelsFile = path.join(tmp, "models.json");
  fs.writeFileSync(
    modelsFile,
    JSON.stringify({
      models: [
        {
          id: "mock",
          label: "Mock",
          provider: "Test",
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          model: "mock-1",
          apiKey: "k",
        },
      ],
    }),
  );

  const child = spawn(process.execPath, [entry, "--port", "0"], {
    cwd: root,
    env: {
      ...process.env,
      TSA_MODELS_FILE: modelsFile,
      TSA_MODELS_LOCAL_FILE: path.join(tmp, "local.json"),
      TSA_STATE_DIR: path.join(tmp, "state"),
      NO_COLOR: "1",
    },
  });

  try {
    const base = await waitForUrl(child);
    const client = new OpenAI({ baseURL: `${base}/v1`, apiKey: "test-key" });

    // 1. non-streaming
    const completion = await client.chat.completions.create({
      model: "mock",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.choices[0].message.role, "assistant");
    assert.equal(completion.choices[0].message.content, REPLY);
    assert.equal(completion.usage.total_tokens, 7);

    // 2. streaming
    const stream = await client.chat.completions.create({
      model: "mock",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    let text = "";
    let sawFinish = false;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
      if (chunk.choices[0]?.finish_reason === "stop") sawFinish = true;
    }
    assert.equal(text, REPLY);
    assert.ok(sawFinish, "stream must end with finish_reason=stop");

    // 3. unknown model surfaces as a proper API error
    await assert.rejects(
      () =>
        client.chat.completions.create({
          model: "does-not-exist",
          messages: [{ role: "user", content: "hi" }],
        }),
      (err) => {
        assert.equal(err.status, 404);
        assert.match(JSON.stringify(err.body ?? err.message), /Unknown model|未知模型/);
        return true;
      },
    );

    console.log("\n✅ contract test passed (openai sdk v%s)", OpenAI.VERSION ?? "?");
  } finally {
    child.kill();
    upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n❌ contract test failed:", err);
  upstream.close();
  process.exit(1);
});
