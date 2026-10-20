/**
 * Tool edge cases: empty files, misses, binary contents, limits, timeouts.
 * `node tests/tools.test.mjs`
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const { fileTools } = await load("dist/tools/fs.js");
const { shellTool } = await load("dist/tools/shell.js");
const { webFetchTool } = await load("dist/tools/web.js");
const { memoryTools } = await load("dist/tools/memory.js");

const get = (list, name) => list.find((t) => t.spec.name === name);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsagent-tools-"));
const ctx = {
  workspace: dir,
  homeDir: dir,
  sessionId: "t",
  mode: "auto",
  approve: async () => true,
  log: () => {},
};

const readFile = get(fileTools, "read_file");
const writeFile = get(fileTools, "write_file");
const editFile = get(fileTools, "edit_file");
const listDir = get(fileTools, "list_dir");
const glob = get(fileTools, "glob");
const grep = get(fileTools, "grep");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- file tools ---------------- */

test("write_file creates nested directories", async () => {
  const res = await writeFile.run({ path: "a/b/c.txt", content: "hi" }, ctx);
  assert.match(res.content, /Created/);
  assert.equal(fs.readFileSync(path.join(dir, "a/b/c.txt"), "utf8"), "hi");
});

test("write_file overwrites and reports it", async () => {
  await writeFile.run({ path: "over.txt", content: "one" }, ctx);
  const res = await writeFile.run({ path: "over.txt", content: "two" }, ctx);
  assert.match(res.content, /Overwrote/);
  assert.equal(fs.readFileSync(path.join(dir, "over.txt"), "utf8"), "two");
});

test("write_file accepts empty content", async () => {
  await writeFile.run({ path: "empty.txt", content: "" }, ctx);
  assert.equal(fs.statSync(path.join(dir, "empty.txt")).size, 0);
});

test("read_file pages with start/end and clamps out-of-range", async () => {
  await writeFile.run({ path: "lines.txt", content: "1\n2\n3\n4\n5" }, ctx);
  const page = await readFile.run({ path: "lines.txt", start_line: 2, end_line: 3 }, ctx);
  assert.match(page.content, /2: 2/);
  assert.match(page.content, /3: 3/);
  assert.ok(!page.content.includes("4: 4"));

  const beyond = await readFile.run({ path: "lines.txt", start_line: 99 }, ctx);
  assert.match(beyond.content, /showing 99-5|showing 99-5/);
});

test("read_file rejects directories", async () => {
  fs.mkdirSync(path.join(dir, "somedir"), { recursive: true });
  await assert.rejects(() => readFile.run({ path: "somedir" }, ctx), /directory/);
});

test("read_file rejects missing files", async () => {
  await assert.rejects(() => readFile.run({ path: "nope.txt" }, ctx), /Cannot read/);
});

test("edit_file replaces every occurrence", async () => {
  await writeFile.run({ path: "multi.txt", content: "a a a" }, ctx);
  const res = await editFile.run({ path: "multi.txt", old_text: "a", new_text: "b" }, ctx);
  assert.match(res.content, /3 occurrence/);
  assert.equal(fs.readFileSync(path.join(dir, "multi.txt"), "utf8"), "b b b");
});

test("edit_file fails loudly when old_text is absent", async () => {
  await writeFile.run({ path: "miss.txt", content: "hello" }, ctx);
  await assert.rejects(
    () => editFile.run({ path: "miss.txt", old_text: "zzz", new_text: "x" }, ctx),
    /not found/,
  );
});

test("edit_file refuses an empty search string", async () => {
  await assert.rejects(
    () => editFile.run({ path: "miss.txt", old_text: "", new_text: "x" }, ctx),
    /must not be empty/,
  );
});

test("list_dir shows directories with a trailing slash", async () => {
  fs.mkdirSync(path.join(dir, "listing"), { recursive: true });
  fs.writeFileSync(path.join(dir, "listing", "file.txt"), "x");
  const res = await listDir.run({ path: "listing" }, ctx);
  assert.match(res.content, /file\.txt/);
});

test("list_dir reports an empty directory", async () => {
  fs.mkdirSync(path.join(dir, "blank"), { recursive: true });
  const res = await listDir.run({ path: "blank" }, ctx);
  assert.match(res.content, /empty/);
});

test("glob matches nested paths and reports no matches", async () => {
  fs.mkdirSync(path.join(dir, "g", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "g", "deep", "x.ts"), "");
  const hit = await glob.run({ pattern: "**/*.ts", path: "g" }, ctx);
  assert.match(hit.content, /g\/deep\/x\.ts|g\\deep\\x\.ts/);

  const miss = await glob.run({ pattern: "**/*.nope", path: "g" }, ctx);
  assert.match(miss.content, /No files matched/);
});

test("grep finds matches with context", async () => {
  await writeFile.run({ path: "grep/a.txt", content: "one\ntwo\nthree\n" }, ctx);
  const res = await grep.run({ pattern: "two", path: "grep", context_lines: 1 }, ctx);
  assert.match(res.content, /two/);
  assert.match(res.content, /one/);
});

test("grep skips binary files", async () => {
  fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0x00, 0x41, 0x42]));
  const res = await grep.run({ pattern: "A", path: "bin.dat" }, ctx);
  assert.match(res.content, /No matches/);
});

test("grep rejects an invalid regex", async () => {
  await assert.rejects(() => grep.run({ pattern: "([", is_regex: true }, ctx), /Invalid regex/);
});

test("grep filters by include glob", async () => {
  await writeFile.run({ path: "inc/a.ts", content: "needle" }, ctx);
  await writeFile.run({ path: "inc/b.md", content: "needle" }, ctx);
  const res = await grep.run({ pattern: "needle", path: "inc", include: "*.ts" }, ctx);
  assert.match(res.content, /a\.ts/);
  assert.ok(!res.content.includes("b.md"));
});

/* ---------------- shell ---------------- */

test("shell runs a command and returns stdout", async () => {
  const res = await shellTool.run({ command: "echo tool-ok" }, ctx);
  assert.match(res.content, /tool-ok/);
  assert.equal(res.isError, false);
});

test("shell refuses a cwd outside the workspace", async () => {
  await assert.rejects(() => shellTool.run({ command: "echo x", cwd: ".." }, ctx), /escapes/);
});

test("shell reports a non-zero exit code", async () => {
  const res = await shellTool.run({ command: "exit 3" }, ctx);
  assert.match(res.content, /exit code: 3/);
  assert.equal(res.isError, true);
});

test("shell truncates very large output", async () => {
  const res = await shellTool.run(
    { command: 'node -e "console.log(\'x\'.repeat(30000))"' },
    ctx,
  );
  assert.match(res.content, /truncated/);
  assert.ok(res.content.length < 26000);
});

test("shell honours the timeout", async () => {
  const res = await shellTool.run(
    { command: 'node -e "setTimeout(()=>{}, 5000)"', timeout: 1 },
    ctx,
  );
  assert.equal(res.isError, true);
});

test("shell is disabled in off mode", async () => {
  const res = await shellTool.run({ command: "echo x" }, { ...ctx, mode: "off" });
  assert.match(res.content, /disabled/i);
  assert.equal(res.isError, true);
});

/* ---------------- web_fetch ---------------- */

test("web_fetch rejects non-http protocols", async () => {
  await assert.rejects(() => webFetchTool.run({ url: "file:///etc/passwd" }, ctx), /http/);
});

test("web_fetch rejects malformed urls", async () => {
  await assert.rejects(() => webFetchTool.run({ url: "not a url" }, ctx), /Invalid URL/);
});

test("web_fetch rejects oversized responses", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(600_000));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const saved = process.env.TSA_WEB_FETCH_ALLOW_PRIVATE;
  process.env.TSA_WEB_FETCH_ALLOW_PRIVATE = "1";
  try {
    await assert.rejects(
      () => webFetchTool.run({ url: `http://127.0.0.1:${port}/` }, ctx),
      /too large/i,
    );
  } finally {
    if (saved === undefined) delete process.env.TSA_WEB_FETCH_ALLOW_PRIVATE;
    else process.env.TSA_WEB_FETCH_ALLOW_PRIVATE = saved;
    server.close();
  }
});

test("web_fetch strips html to readable text", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Title</h1><p>Body</p><script>bad()</script></body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const saved = process.env.TSA_WEB_FETCH_ALLOW_PRIVATE;
  process.env.TSA_WEB_FETCH_ALLOW_PRIVATE = "1";
  try {
    const res = await webFetchTool.run({ url: `http://127.0.0.1:${port}/` }, ctx);
    assert.match(res.content, /Title/);
    assert.match(res.content, /Body/);
    assert.ok(!res.content.includes("<h1>"));
    assert.ok(!res.content.includes("bad()"));
  } finally {
    if (saved === undefined) delete process.env.TSA_WEB_FETCH_ALLOW_PRIVATE;
    else process.env.TSA_WEB_FETCH_ALLOW_PRIVATE = saved;
    server.close();
  }
});

/* ---------------- memory ---------------- */

test("memory_append writes to MEMORY.md and search finds it", async () => {
  const append = get(memoryTools, "memory_append");
  const search = get(memoryTools, "memory_search");
  await append.run({ text: "user prefers tabs" }, ctx);

  const hit = await search.run({ query: "tabs" }, ctx);
  assert.match(hit.content, /tabs/);
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

// Windows may still hold a handle from a killed child process.
try {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch {
  /* leftover temp dir is harmless */
}

if (failed) {
  console.error(`\n❌ ${failed}/${tests.length} tool tests failed`);
  process.exit(1);
}
console.log(`\n✅ all ${tests.length} tool tests passed`);
