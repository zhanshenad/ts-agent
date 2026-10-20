/**
 * Retry behaviour of the streaming client: a dropped connection must be
 * retried on a fresh socket instead of surfacing "fetch failed".
 * `npm run test:retry`
 */
import http from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const { chatCompletionStream } = await import(
  pathToFileURL(path.join(root, "dist", "llm.js")).href
);

let calls = 0;

const server = http.createServer((req, res) => {
  calls += 1;

  if (calls === 1) {
    // Simulate a keep-alive socket the server already closed.
    res.destroy();
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "retried-ok" } }] })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
});

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const cfg = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key",
    model: "mock",
    temperature: 0.2,
    maxTokens: undefined,
    maxIterations: 1,
    workspace: root,
    homeDir: root,
    autoApprove: false,
  };

  let text = "";
  let done = false;
  for await (const evt of chatCompletionStream(cfg, [{ role: "user", content: "hi" }])) {
    if (evt.type === "text") text += evt.text;
    if (evt.type === "done") done = true;
  }

  assert.equal(text, "retried-ok", "should have recovered on the retry");
  assert.ok(done, "stream should complete");
  assert.equal(calls, 2, `expected exactly one retry, got ${calls} attempts`);

  console.log("\n✅ stream retry test passed (attempts: %d)", calls);
  server.close();
}

main().catch((err) => {
  console.error("\n❌ retry test failed:", err);
  server.close();
  process.exit(1);
});
