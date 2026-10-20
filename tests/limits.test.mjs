/**
 * Limits and boundary conditions across uploads, model storage, sessions, CLI.
 * `node tests/limits.test.mjs`
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "server.js");
const cli = path.join(root, "dist", "index.js");

const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

/* ---------------- mock upstream ---------------- */

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { choices: [{ delta: { content: "ok" } }] });
    sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
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

function multipart(files) {
  const boundary = "----limits-test";
  const chunks = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\n` +
          `Content-Type: ${f.type}\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/* ---------------- test ---------------- */

async function main() {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tsagent-limits-"));
  const modelsFile = path.join(tmp, "models.json");
  const localFile = path.join(tmp, "models.local.json");
  const stateDir = path.join(tmp, "state");

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
        { id: "builtin", label: "Builtin", provider: "T", baseUrl: "https://x/v1", model: "b" },
      ],
    }),
  );

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

    /* ---- uploads ---- */
    const empty = multipart([{ name: "zero.txt", type: "text/plain", data: "" }]);
    const emptyRes = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": empty.contentType },
      body: empty.body,
    });
    assert.equal(emptyRes.status, 400, "an empty file is rejected");

    const traversal = multipart([
      { name: "../../evil.txt", type: "text/plain", data: "pwned" },
    ]);
    const travRes = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": traversal.contentType },
      body: traversal.body,
    });
    assert.equal(travRes.status, 200);
    const travJson = await travRes.json();
    assert.equal(travJson.files[0].name, "evil.txt", "traversal is stripped from the name");
    assert.ok(
      !fs.existsSync(path.join(tmp, "evil.txt")),
      "file must not escape the uploads directory",
    );
    assert.ok(fs.existsSync(path.join(stateDir, "uploads", travJson.files[0].id)));

    const multi = multipart([
      { name: "a.txt", type: "text/plain", data: "aaa" },
      { name: "b.md", type: "text/markdown", data: "# bbb" },
      { name: "c.json", type: "application/json", data: '{"c":1}' },
    ]);
    const multiRes = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": multi.contentType },
      body: multi.body,
    });
    assert.equal(multiRes.status, 200);
    assert.equal((await multiRes.json()).files.length, 3);

    const tooBig = multipart([
      { name: "big.bin", type: "application/octet-stream", data: Buffer.alloc(10 * 1024 * 1024 + 2048, 0x61) },
    ]);
    const bigRes = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "content-type": tooBig.contentType },
      body: tooBig.body,
    });
    assert.equal(bigRes.status, 400, ">10MB is rejected");

    const badPreview = await fetch(`${base}/uploads/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(badPreview.status, 404);

    /* ---- model storage ---- */
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fetch(`${base}/api/models`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: `concurrent-${i}`,
            label: `C${i}`,
            baseUrl: "https://x/v1",
            model: "m",
            apiKey: "k",
          }),
        }).then((r) => r.status),
      ),
    );
    assert.deepEqual(created, Array(10).fill(200), "concurrent saves all succeed");

    const catalog = await (await fetch(`${base}/api/models`)).json();
    const ids = catalog.models.map((m) => m.id);
    for (let i = 0; i < 10; i++) assert.ok(ids.includes(`concurrent-${i}`), `concurrent-${i} present`);

    const stored = JSON.parse(fs.readFileSync(localFile, "utf8"));
    assert.equal(stored.models.length, 10, "the file is valid JSON with every entry");

    const delBuiltin = await fetch(`${base}/api/models/builtin`, { method: "DELETE" });
    assert.equal(delBuiltin.status, 200);
    const afterDel = await (await fetch(`${base}/api/models`)).json();
    assert.ok(!afterDel.models.some((m) => m.id === "builtin"), "built-in can be hidden");

    /* ---- sessions ---- */
    fs.mkdirSync(path.join(stateDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "sessions", "broken.json"), "{not json");

    const broken = await fetch(`${base}/api/sessions/broken`);
    assert.equal(broken.status, 404, "a corrupt session file is a 404, not a crash");

    const traversalSession = await fetch(`${base}/api/sessions/..%2F..%2Fpackage`);
    assert.equal(traversalSession.status, 404);

    const fresh = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    const freshBody = await (await fetch(`${base}/api/sessions/${fresh.id}`)).json();
    assert.deepEqual(freshBody.messages, [], "a new session starts empty");
    assert.ok(fs.existsSync(path.join(stateDir, "sessions", `${fresh.id}.json`)));

    /* ---- health ---- */
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.busySessions, 0);
    assert.equal(health.pendingApprovals, 0);
    assert.ok(health.maxMode);

    console.log("  ✔ http limits (uploads, models, sessions)");
  } finally {
    child.kill();
    upstream.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }

  /* ---- CLI argument handling ---- */
  const cliRun = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 20000,
    });

  const help = cliRun(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--mode/);

  const badFlag = cliRun(["--nope"]);
  assert.equal(badFlag.status, 2, "unknown flag exits 2");
  assert.match(badFlag.stderr, /Unknown option/);

  const missingValue = cliRun(["--mode"]);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /Missing value/);

  const version = cliRun(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);

  console.log("  ✔ cli argument handling");
  console.log("\n✅ all limit tests passed");
}

main().catch((err) => {
  console.error("\n❌ limit test failed:", err);
  upstream.close();
  process.exit(1);
});
