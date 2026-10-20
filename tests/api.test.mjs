/**
 * Layer 2 — HTTP integration tests: boundaries, failures, concurrency.
 * `node tests/api.test.mjs`
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "server.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = { calls: 0, lastMessages: [] };

/* ---------------- mock upstream ---------------- */

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    stats.calls += 1;
    const body = JSON.parse(raw || "{}");
    stats.lastMessages = body.messages ?? [];
    const userText = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    const lastMsg = (body.messages ?? [])[body.messages.length - 1];
    const hadTool = lastMsg?.role === "tool";

    if (/fail-401/.test(userText)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }

    if (/fail-500/.test(userText)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "boom" } }));
      return;
    }

    if (/slow/.test(userText)) await sleep(1800);

    res.writeHead(200, { "content-type": "text/event-stream" });

    // Pick the command the mock asks the agent to run.
    let toolCommand = null;
    if (!hadTool) {
      if (/run-safe/.test(userText)) toolCommand = "echo safe-ok";
      else if (/run-danger/.test(userText)) toolCommand = "echo DANGER_RAN > danger_probe.txt";
      else if (/run-a-shell/.test(userText)) toolCommand = "echo SHOULD_NOT_RUN > probe.txt";
    }

    if (toolCommand) {
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "shell", arguments: JSON.stringify({ command: toolCommand }) },
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

    const reply = hadTool ? "done-with-tool" : "plain-reply";
    for (const ch of reply) {
      sse(res, { choices: [{ delta: { content: ch }, finish_reason: null }] });
    }
    sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

/* ---------------- helpers ---------------- */

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

async function collect(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") {
            const evt = JSON.parse(payload);
            events.push(evt);
            // Answer prompts immediately — the agent is blocked on them.
            if (onEvent) onEvent(evt);
          }
        }
      }
    }
  }
  return events;
}

const chat = (base, body) =>
  fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const health = async (base) => (await fetch(`${base}/api/health`)).json();

/* ---------------- test ---------------- */

async function main() {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tsagent-api-"));
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
      TSA_APPROVAL_TIMEOUT_MS: "1500",
      NO_COLOR: "1",
    },
  });

  try {
    const base = await waitForUrl(child);

    /* ---- sessions ---- */
    const created = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    assert.ok(created.id, "POST /api/sessions returns an id");
    assert.equal((await fetch(`${base}/api/sessions/${created.id}`)).status, 200);

    /* ---- malformed input ---- */
    const badJson = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);

    const tooLong = await chat(base, { modelId: "mock", message: "x".repeat(100_001) });
    assert.equal(tooLong.status, 400, "oversized message rejected");

    const noMessage = await chat(base, { modelId: "mock" });
    assert.equal(noMessage.status, 400);

    const unknownRoute = await fetch(`${base}/api/nope`);
    assert.equal(unknownRoute.status, 404);

    const preflight = await fetch(`${base}/api/chat`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods"), /DELETE/);

    /* ---- approval denied ---- */
    const denied = await chat(base, {
      modelId: "mock",
      sessionId: created.id,
      message: "run-a-shell please",
    });
    let sawApproval = false;
    let deniedText = "";
    const approvalResponses = [];
    const events1 = await collect(denied, (evt) => {
      if (evt.type === "approval" && !sawApproval) {
        sawApproval = true;
        approvalResponses.push(
          fetch(`${base}/api/chat/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approvalId: evt.approvalId, approved: false }),
          })
            .then((r) => r.json())
            .then((j) => j.ok),
        );
      }
    });
    for (const evt of events1) if (evt.type === "delta") deniedText += evt.text;

    const approvalResults = await Promise.all(approvalResponses);
    assert.ok(sawApproval, "approval prompt expected");
    assert.equal(approvalResults[0], true);
    assert.equal(deniedText, "done-with-tool", "agent must continue after a denial");
    assert.ok(!fs.existsSync(path.join(root, "probe.txt")), "denied command must not run");

    /* ---- approval timeout (400ms in this run) ---- */
    const timeoutRun = await chat(base, {
      modelId: "mock",
      sessionId: created.id,
      message: "run-a-shell again",
    });
    const timeoutEvents = await collect(timeoutRun);
    assert.ok(
      timeoutEvents.some((e) => e.type === "approval_timeout"),
      "no answer should time out",
    );

    /* ---- disconnect releases the session lock ---- */
    const before = await health(base);
    assert.equal(before.busySessions, 0, "no session should be busy now");

    const controller = new AbortController();
    const dangling = fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: "mock",
        sessionId: created.id,
        message: "run-a-shell hang",
      }),
      signal: controller.signal,
    }).catch(() => null);

    await sleep(600); // let the approval prompt be emitted
    controller.abort();
    await dangling;

    let released = false;
    for (let i = 0; i < 20; i++) {
      const h = await health(base);
      if (h.busySessions === 0 && h.pendingApprovals === 0) {
        released = true;
        break;
      }
      await sleep(100);
    }
    assert.ok(released, "closing the tab must release the pending approval and the session lock");

    /* ---- upstream 401 ---- */
    const unauth = await chat(base, { modelId: "mock", message: "fail-401" });
    const unauthEvents = await collect(unauth);
    const unauthErr = unauthEvents.find((e) => e.type === "error");
    assert.ok(unauthErr, "should surface an error frame");
    assert.match(unauthErr.message, /401/);

    /* ---- upstream 500 is retried, then surfaces ---- */
    const callsBefore = stats.calls;
    const boom = await chat(base, { modelId: "mock", message: "fail-500" });
    const boomEvents = await collect(boom);
    const boomErr = boomEvents.find((e) => e.type === "error");
    assert.ok(boomErr, "500 should surface as an error frame");
    assert.ok(
      stats.calls - callsBefore >= 3,
      `expected retries, upstream saw ${stats.calls - callsBefore} calls`,
    );

    /* ---- concurrent turn on the same session ---- */
    const slow = chat(base, { modelId: "mock", sessionId: created.id, message: "slow" });
    await sleep(400);
    const conflict = await chat(base, { modelId: "mock", sessionId: created.id, message: "hi" });
    assert.equal(conflict.status, 409, "second concurrent turn must be rejected");
    await slow.then((r) => r.text());

    /* ---- permission modes ---- */
    async function runWithMode(mode, message) {
      const res = await chat(base, { modelId: "mock", message, mode });
      const approvals = [];
      const events = await collect(res, (evt) => {
        if (evt.type === "approval") {
          approvals.push(evt);
          void fetch(`${base}/api/chat/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approvalId: evt.approvalId, approved: true }),
          });
        }
      });
      const start = events.find((e) => e.type === "start");
      const toolEnd = events.find((e) => e.type === "tool_end");
      const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
      return {
        mode: start?.mode,
        approvals: approvals.length,
        text,
        toolPreview: toolEnd?.preview ?? "",
      };
    }

    const safeSmart = await runWithMode("smart", "run-safe");
    assert.equal(safeSmart.approvals, 0, "smart: a safe command runs without asking");
    assert.equal(safeSmart.text, "done-with-tool");

    const dangerSmart = await runWithMode("smart", "run-danger");
    assert.equal(dangerSmart.approvals, 1, "smart: a dangerous command asks");
    assert.ok(fs.existsSync(path.join(root, "danger_probe.txt")), "approved command really ran");

    const safeStrict = await runWithMode("strict", "run-safe");
    assert.equal(safeStrict.approvals, 1, "strict: even safe commands ask");

    const offRun = await runWithMode("off", "run-safe");
    assert.equal(offRun.approvals, 0, "off: nothing to approve");
    assert.match(offRun.toolPreview, /disabled/i, "off: shell reports that it is disabled");

    const autoRun = await runWithMode("auto", "run-safe");
    assert.equal(autoRun.mode, "smart", "auto must be clamped to the server ceiling");

    /* ---- uploads ---- */
    function multipart(name, type, data) {
      const boundary = "----tsagent-test";
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
            `Content-Type: ${type}\r\n\r\n`,
        ),
        Buffer.from(data),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return { body, contentType: `multipart/form-data; boundary=${boundary}` };
    }

    const mp = multipart("notes.txt", "text/plain", "SECRET_MARKER_42");
    const upRes = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": mp.contentType },
      body: mp.body,
    });
    assert.equal(upRes.status, 200);
    const upJson = await upRes.json();
    assert.ok(upJson.files[0].id, "upload returns an id");
    assert.equal(upJson.files[0].kind, "text");
    assert.equal(upJson.files[0].size, 16);

    const preview = await fetch(`${base}${upJson.files[0].url}`);
    assert.equal(preview.status, 200);
    assert.equal(await preview.text(), "SECRET_MARKER_42");

    const withAttach = await chat(base, {
      modelId: "mock",
      message: "summarize this",
      attachments: [{ id: upJson.files[0].id }],
    });
    assert.equal(withAttach.status, 200);
    await collect(withAttach);
    const lastUser = [...stats.lastMessages].reverse().find((m) => m.role === "user");
    const content =
      typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
    assert.match(content, /SECRET_MARKER_42/, "text attachment must be inlined into the turn");

    const badUpload = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1 }),
    });
    assert.equal(badUpload.status, 400);

    const missingFile = await fetch(`${base}/uploads/nope.txt`);
    assert.equal(missingFile.status, 404);

    /* ---- images always go out as multimodal parts ---- */
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const imgMp = multipart("photo.png", "image/png", png);
    const imgRes = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": imgMp.contentType },
      body: imgMp.body,
    });
    const imgJson = await imgRes.json();
    assert.equal(imgJson.files[0].kind, "image");

    const withImage = await chat(base, {
      modelId: "mock",
      message: "look at this",
      attachments: [{ id: imgJson.files[0].id }],
    });
    await collect(withImage);

    const imageUser = [...stats.lastMessages].reverse().find((m) => m.role === "user");
    assert.ok(Array.isArray(imageUser?.content), "image turns use a multipart body");
    assert.ok(
      imageUser.content.some(
        (p) => p.type === "image_url" && String(p.image_url?.url).startsWith("data:image/png;base64,"),
      ),
      "image must be inlined as a data URL",
    );
    assert.ok(
      imageUser.content.some((p) => p.type === "text" && p.text.includes("look at this")),
      "the user text must survive alongside the image",
    );

    /* ---- SSRF guard ---- */
    const { webFetchTool } = await import(
      pathToFileURL(path.join(root, "dist", "tools", "web.js")).href
    );
    const ctx = { workspace: root, homeDir: tmp, sessionId: "t", approve: async () => true, log: () => {} };
    await assert.rejects(
      () => webFetchTool.run({ url: "http://127.0.0.1:8787/api/models" }, ctx),
      /private address/,
    );
    await assert.rejects(
      () => webFetchTool.run({ url: "http://169.254.169.254/latest/meta-data" }, ctx),
      /private address/,
    );
    await assert.rejects(
      () => webFetchTool.run({ url: "http://10.0.0.5/" }, ctx),
      /private address/,
    );

    console.log("\n✅ api integration tests passed");
  } finally {
    child.kill();
    upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.join(root, "probe.txt"), { force: true });
    fs.rmSync(path.join(root, "danger_probe.txt"), { force: true });
  }
}

main().catch((err) => {
  console.error("\n❌ api integration test failed:", err);
  upstream.close();
  process.exit(1);
});
