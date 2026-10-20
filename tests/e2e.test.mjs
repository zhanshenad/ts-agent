/**
 * Layer 3 — browser E2E. Drives the real page in Chromium against a mock model.
 * `node tests/e2e.test.mjs`
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "server.js");

const sse = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

/* ---------------- mock upstream ---------------- */

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const userText =
      [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    const lastMsg = (body.messages ?? [])[body.messages.length - 1];
    const hadTool = lastMsg?.role === "tool";

    res.writeHead(200, { "content-type": "text/event-stream" });

    if (/run-a-shell/.test(userText) && !hadTool) {
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "shell",
                    arguments: JSON.stringify({ command: "echo e2e-ok" }),
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

    const reply = hadTool ? "e2e-done" : "e2e-hello";
    for (const ch of reply) {
      sse(res, { choices: [{ delta: { content: ch }, finish_reason: null }] });
    }
    sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

/* ---------------- helpers ---------------- */

/** Reuse whatever Chromium Playwright already downloaded on this machine. */
function findChromium() {
  if (process.env.PW_CHROMIUM_PATH && fs.existsSync(process.env.PW_CHROMIUM_PATH)) {
    return process.env.PW_CHROMIUM_PATH;
  }
  const base = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (!fs.existsSync(base)) return undefined;
  const dirs = fs
    .readdirSync(base)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const dir of dirs) {
    for (const sub of ["chrome-win64", "chrome-win"]) {
      const exe = path.join(base, dir, sub, "chrome.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

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

/* ---------------- test ---------------- */

async function main() {
  const executablePath = findChromium();
  if (!executablePath) {
    console.log("⚠ no Chromium found — set PW_CHROMIUM_PATH. Skipping E2E.");
    process.exit(0);
  }

  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tsagent-e2e-"));
  const modelsFile = path.join(tmp, "models.json");
  fs.writeFileSync(
    modelsFile,
    JSON.stringify({
      models: [
        {
          id: "mock",
          label: "Mock Model",
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

  let browser;
  try {
    const base = await waitForUrl(child);
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });

    /* 1. page boots and lists the model */
    await page.goto(base, { waitUntil: "load" });
    await page.waitForSelector("#model option", { state: "attached" });
    const options = await page.locator("#model option").allTextContents();
    assert.ok(
      options.some((o) => o.includes("Mock Model")),
      `model list should contain the mock, got: ${options.join(" | ")}`,
    );
    assert.equal(await page.locator("#empty").isVisible(), true, "empty state visible");

    /* 2. plain turn */
    await page.locator("#input").fill("hello there");
    await page.locator("#btn-send").click();
    await page.waitForFunction(() => document.body.innerText.includes("e2e-hello"), null, {
      timeout: 15000,
    });
    assert.equal(await page.locator(".msg.user").count(), 1);
    assert.match(await page.locator(".msg.assistant .meta").first().innerText(), /Mock Model/);

    /* 3. tool call → approval card → allow → tool output */
    await page.locator("#input").fill("run-a-shell now");
    await page.locator("#btn-send").click();

    await page.waitForSelector(".seg.tool.running", { timeout: 15000 });
    await page.waitForSelector(".seg.approval", { timeout: 15000 });
    assert.match(await page.locator(".seg.approval").innerText(), /需要你确认/);

    await page.getByRole("button", { name: "允许" }).click();
    await page.waitForFunction(
      () => document.querySelector(".seg.approval")?.innerText.includes("已允许"),
      null,
      { timeout: 15000 },
    );
    await page.waitForSelector(".seg.tool.ok", { timeout: 15000 });
    assert.match(await page.locator(".seg.tool.ok").innerText(), /e2e-ok/);

    await page.waitForFunction(() => document.body.innerText.includes("e2e-done"), null, {
      timeout: 15000,
    });

    /* 4. reload restores the session */
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.body.innerText.includes("e2e-done"), null, {
      timeout: 15000,
    });
    assert.ok(
      (await page.locator(".msg.user").count()) >= 2,
      "both user turns should be restored",
    );

    /* 5. model manager reflects the catalogue */
    await page.getByRole("button", { name: "设置" }).click();
    await page.waitForSelector("#model-list .model-item");
    assert.match(await page.locator("#model-list").innerText(), /Mock Model/);

    console.log("\n✅ e2e tests passed");
    console.log(`   chromium: ${executablePath}`);
  } finally {
    if (browser) await browser.close();
    child.kill();
    upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\n❌ e2e test failed:", err);
  upstream.close();
  process.exit(1);
});
