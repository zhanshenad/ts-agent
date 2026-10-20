/**
 * SSE parser edge cases — separator styles, chunk boundaries, malformed frames.
 * `node tests/stream.test.mjs`
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Feed the client these byte chunks in order, then close. */
async function run(chunks) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    void (async () => {
      for (const chunk of chunks) {
        res.write(chunk);
        await sleep(4);
      }
      res.end();
    })();
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const cfg = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "k",
    model: "m",
    temperature: 0,
    maxTokens: undefined,
    maxIterations: 1,
    workspace: root,
    homeDir: root,
    autoApprove: false,
  };

  let text = "";
  let done = null;
  try {
    for await (const evt of chatCompletionStream(cfg, [{ role: "user", content: "hi" }])) {
      if (evt.type === "text") text += evt.text;
      else done = evt;
    }
  } finally {
    server.close();
  }
  return { text, done };
}

const delta = (content) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;

/* ---------------- tests ---------------- */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("parses LF frames", async () => {
  const { text } = await run([delta("a"), delta("b"), "data: [DONE]\n\n"]);
  assert.equal(text, "ab");
});

test("parses CRLF frames", async () => {
  const crlf = (c) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\r\n\r\n`;
  const { text } = await run([crlf("x"), crlf("y"), "data: [DONE]\r\n\r\n"]);
  assert.equal(text, "xy");
});

test("reassembles a frame split across chunks", async () => {
  const frame = delta("hello");
  const cut = Math.floor(frame.length / 2);
  const { text } = await run([frame.slice(0, cut), frame.slice(cut), "data: [DONE]\n\n"]);
  assert.equal(text, "hello");
});

test("keeps multi-byte characters intact when split mid-byte", async () => {
  const frame = Buffer.from(delta("你好"), "utf8");
  const bytes = [...frame];
  // split inside the first Chinese character (3 bytes)
  const cut = bytes.indexOf(0xe4) + 1;
  const head = Buffer.from(bytes.slice(0, cut));
  const tail = Buffer.from(bytes.slice(cut));
  const { text } = await run([head, tail, "data: [DONE]\n\n"]);
  assert.equal(text, "你好");
});

test("finishes without a [DONE] sentinel", async () => {
  const { text, done } = await run([delta("a"), delta("b")]);
  assert.equal(text, "ab");
  assert.ok(done, "a done event must still be emitted");
});

test("ignores keep-alive comments", async () => {
  const { text } = await run([": ping\n\n", delta("ok"), ": ping\n\n", "data: [DONE]\n\n"]);
  assert.equal(text, "ok");
});

test("skips malformed frames instead of crashing", async () => {
  const { text } = await run(["data: {not json}\n\n", delta("still-alive"), "data: [DONE]\n\n"]);
  assert.equal(text, "still-alive");
});

test("accumulates tool calls split across frames", async () => {
  const part1 = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: "c1", function: { name: "read_", arguments: '{"pa' } }],
        },
      },
    ],
  });
  const part2 = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"a"}' } }] } }],
  });
  const { done } = await run([
    `data: ${part1}\n\n`,
    `data: ${part2}\n\n`,
    "data: [DONE]\n\n",
  ]);

  assert.equal(done.toolCalls.length, 1);
  assert.equal(done.toolCalls[0].function.name, "read_file");
  assert.equal(done.toolCalls[0].function.arguments, '{"path":"a"}');
});

test("handles an empty stream", async () => {
  const { text, done } = await run([]);
  assert.equal(text, "");
  assert.ok(done);
  assert.equal(done.toolCalls.length, 0);
});

test("delivers the finish reason", async () => {
  const { done } = await run([
    delta("x"),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
    "data: [DONE]\n\n",
  ]);
  assert.equal(done.finishReason, "length");
});

test("processes several frames arriving in one chunk", async () => {
  const { text } = await run([delta("a") + delta("b") + delta("c"), "data: [DONE]\n\n"]);
  assert.equal(text, "abc");
});

/* ---------------- runner ---------------- */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✖ ${name}\n    ${err.message}`);
  }
}

if (failed) {
  console.error(`\n❌ ${failed}/${tests.length} stream tests failed`);
  process.exit(1);
}
console.log(`\n✅ all ${tests.length} stream tests passed`);
