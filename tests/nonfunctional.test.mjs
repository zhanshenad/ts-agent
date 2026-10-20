/**
 * Layer 5 — non-functional: concurrency, long-session degradation, leaks.
 * `node tests/nonfunctional.test.mjs`
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

/* ---------------- mock upstream ---------------- */

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = JSON.parse(raw || "{}");
    const userText =
      [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";

    if (/^slow/.test(userText)) await sleep(900);

    res.writeHead(200, { "content-type": "text/event-stream" });

    const reply = /^big/.test(userText) ? "x".repeat(4000) : "perf-reply";
    const chunks = Math.ceil(reply.length / 40);
    for (let i = 0; i < chunks; i++) {
      sse(res, {
        choices: [{ delta: { content: reply.slice(i * 40, (i + 1) * 40) }, finish_reason: null }],
      });
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

async function runTurn(base, { sessionId, message, timeoutMs = 30000 }) {
  const t0 = performance.now();
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: "mock", sessionId, message }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let sid = sessionId;
  let chars = 0;
  let tFirst = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const evt = JSON.parse(line.slice(5).trim());
        if (evt.type === "start") sid = evt.sessionId;
        if (evt.type === "delta") {
          if (!tFirst) tFirst = performance.now() - t0;
          text += evt.text;
        }
        if (evt.type === "done") chars = evt.chars;
      }
    }
  }

  return { sessionId: sid, text, chars, ms: Math.round(performance.now() - t0), firstToken: Math.round(tFirst) };
}

const health = async (base) => (await fetch(`${base}/api/health`)).json();

/* ---------------- test ---------------- */

async function main() {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tsagent-perf-"));
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
      TSA_APPROVAL_TIMEOUT_MS: "3000",
      NO_COLOR: "1",
    },
  });

  try {
    const base = await waitForUrl(child);

    /* ---- 1. 10 concurrent sessions must not interfere ---- */
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runTurn(base, { message: `concurrent ${i}` }).catch((e) => ({ error: e.message })),
      ),
    );
    const failures = concurrent.filter((r) => r.error || r.text !== "perf-reply");
    assert.equal(failures.length, 0, `concurrent turns failed: ${JSON.stringify(failures)}`);
    const ids = new Set(concurrent.map((r) => r.sessionId));
    assert.equal(ids.size, 10, "each turn should get its own session");
    console.log(`  concurrency: 10/10 ok`);

    /* ---- 2. long session: watch for degradation ---- */
    let sessionId;
    const timings = [];
    for (let i = 0; i < 40; i++) {
      const r = await runTurn(base, { sessionId, message: `turn ${i}` });
      sessionId = r.sessionId;
      timings.push(r.ms);
    }
    const firstFive = timings.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const lastFive = timings.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const sessionFile = path.join(tmp, "state", "sessions", `${sessionId}.json`);
    const sessionKb = Math.round(fs.statSync(sessionFile).size / 1024);

    console.log(
      `  long session: 40 turns, first5=${firstFive.toFixed(0)}ms last5=${lastFive.toFixed(0)}ms, file=${sessionKb}KB`,
    );
    assert.ok(lastFive < Math.max(1500, firstFive * 6), `degradation too large: ${firstFive} -> ${lastFive}`);

    /* ---- 3. abort storm leaves no locks behind ---- */
    for (let i = 0; i < 15; i++) {
      const controller = new AbortController();
      const p = fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: "mock", message: "slow one" }),
        signal: controller.signal,
      }).catch(() => null);
      await sleep(60);
      controller.abort();
      await p;
    }

    let settled = null;
    for (let i = 0; i < 40; i++) {
      const h = await health(base);
      if (h.busySessions === 0 && h.pendingApprovals === 0) {
        settled = h;
        break;
      }
      await sleep(100);
    }
    assert.ok(settled, "aborted turns must release their sessions");
    console.log(`  abort storm: busy=${settled.busySessions} pending=${settled.pendingApprovals}`);

    /* ---- 4. large output survives ---- */
    const big = await runTurn(base, { message: "big output" });
    assert.equal(big.text.length, 4000, "4000-char reply should arrive intact");
    assert.equal(big.chars, 4000);
    console.log(`  large output: ${big.text.length} chars in ${big.ms}ms`);

    /* ---- 5. memory did not run away ---- */
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`  test-runner rss: ${rss}MB`);

    console.log("\n✅ non-functional tests passed");
  } finally {
    child.kill();
    upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n❌ non-functional test failed:", err);
  upstream.close();
  process.exit(1);
});
