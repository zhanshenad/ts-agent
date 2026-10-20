/**
 * Layer 1 — unit tests. Pure functions, no network, no server.
 * `node --test tests/unit.test.mjs`
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const { mdToHtml, escapeHtml } = await load("public/markdown.mjs");
const { globToRegExp, resolveInWorkspace, relativeTo } = await load("dist/tools/common.js");
const { validateModelInput, findModel, loadModels } = await load("dist/models.js");
const { searchMemory, memoryFiles } = await load("dist/memory.js");
const { parseDotEnv } = await load("dist/config.js");
const { wireMessages, wireTools } = await load("dist/llm.js");
const { buildSystemPrompt } = await load("dist/prompt.js");
const { classifyCommand, parseMode, clampMode, needsApproval } = await load("dist/permissions.js");
const { safeFileName, classifyFile, parseMultipart, boundaryOf } = await load("dist/uploads.js");

const tmpDirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsagent-unit-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- markdown ---------------- */

describe("escapeHtml", () => {
  test("escapes the five dangerous characters", () => {
    assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  test("leaves plain text alone", () => {
    assert.equal(escapeHtml("你好 hello"), "你好 hello");
  });
});

describe("mdToHtml", () => {
  test("renders bold, inline code and headings", () => {
    assert.match(mdToHtml("**bold**"), /<strong>bold<\/strong>/);
    assert.match(mdToHtml("use `npm test`"), /<code>npm test<\/code>/);
    assert.match(mdToHtml("## Title"), /<h2>Title<\/h2>/);
  });

  test("renders fenced code blocks without interpreting inner markdown", () => {
    const html = mdToHtml("```ts\nconst a = **1**;\n```");
    assert.match(html, /<pre><code>const a = \*\*1\*<\/code><\/pre>|const a = \*\*1\*\*/);
    assert.ok(!html.includes("<strong>"), "bold must not apply inside a code fence");
  });

  test("renders lists and links", () => {
    const html = mdToHtml("- one\n- two");
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(mdToHtml("[docs](https://example.com)"), /<a href="https:\/\/example.com"/);
  });

  test("blocks literal HTML injection", () => {
    const html = mdToHtml('<img src=x onerror="alert(1)">');
    assert.ok(!html.includes("<img"), "raw <img> must not survive");
    assert.ok(html.includes("&lt;img"), "it should be escaped instead");
  });

  test("blocks XSS inside code fences", () => {
    const html = mdToHtml("```\n<script>alert(1)</script>\n```");
    assert.ok(!html.includes("<script>"), "script tag must be escaped");
    assert.ok(html.includes("&lt;script&gt;"));
  });

  test("blocks javascript: links", () => {
    const html = mdToHtml("[click](javascript:alert(1))");
    assert.ok(!html.includes('href="javascript'), "javascript: URLs must not become links");
  });

  test("handles empty and whitespace input", () => {
    assert.equal(mdToHtml(""), "");
    assert.equal(mdToHtml("   "), "");
    assert.equal(mdToHtml(undefined), "");
  });

  test("keeps separate paragraphs", () => {
    const html = mdToHtml("first\n\nsecond");
    assert.match(html, /<p>first<\/p><p>second<\/p>/);
  });
});

/* ---------------- tool path helpers ---------------- */

describe("globToRegExp", () => {
  test("** matches nested paths and bare names", () => {
    const re = globToRegExp("**/*.ts");
    assert.ok(re.test("src/tools/fs.ts"));
    assert.ok(re.test("a.ts"));
    assert.ok(!re.test("a.js"));
  });

  test("*.md does not cross directories", () => {
    const re = globToRegExp("*.md");
    assert.ok(re.test("README.md"));
    assert.ok(!re.test("docs/README.md"));
  });

  test("? matches exactly one character", () => {
    const re = globToRegExp("test?.md");
    assert.ok(re.test("test1.md"));
    assert.ok(!re.test("test12.md"));
  });

  test("dots are literal", () => {
    const re = globToRegExp("a.b");
    assert.ok(re.test("a.b"));
    assert.ok(!re.test("axb"));
  });
});

describe("resolveInWorkspace", () => {
  const workspace = path.resolve(os.tmpdir(), "tsagent-sandbox");

  test("resolves relative paths inside the workspace", () => {
    const out = resolveInWorkspace(workspace, "src/a.ts");
    assert.equal(out, path.join(workspace, "src", "a.ts"));
  });

  test("allows the workspace root itself", () => {
    assert.equal(resolveInWorkspace(workspace, "."), workspace);
  });

  test("rejects ../ escapes", () => {
    assert.throws(() => resolveInWorkspace(workspace, "../outside.txt"), /escapes the workspace/);
  });

  test("rejects absolute paths outside the workspace", () => {
    const outside = path.resolve(os.tmpdir(), "elsewhere", "x.txt");
    assert.throws(() => resolveInWorkspace(workspace, outside), /escapes the workspace/);
  });

  test("accepts absolute paths inside the workspace", () => {
    const inside = path.join(workspace, "a.txt");
    assert.equal(resolveInWorkspace(workspace, inside), inside);
  });

  test("relativeTo normalises separators", () => {
    assert.equal(relativeTo(workspace, path.join(workspace, "src", "a.ts")), "src/a.ts");
  });
});

/* ---------------- model config validation ---------------- */

describe("validateModelInput", () => {
  const ok = {
    id: "my-model",
    label: "My",
    provider: "Test",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-x",
    apiKey: "sk-1",
  };

  test("accepts a well-formed entry", () => {
    const out = validateModelInput(ok);
    assert.equal(out.id, "my-model");
    assert.equal(out.apiKey, "sk-1");
    assert.equal(out.requiresKey, true);
  });

  test("keeps requiresKey=false", () => {
    assert.equal(validateModelInput({ ...ok, requiresKey: false }).requiresKey, false);
  });

  test("rejects ids with spaces or slashes", () => {
    assert.throws(() => validateModelInput({ ...ok, id: "has space" }), /id/);
    assert.throws(() => validateModelInput({ ...ok, id: "../etc" }), /id/);
    assert.throws(() => validateModelInput({ ...ok, id: "" }), /id/);
  });

  test("rejects non-http baseUrl", () => {
    assert.throws(() => validateModelInput({ ...ok, baseUrl: "ftp://x" }), /baseUrl/);
    assert.throws(() => validateModelInput({ ...ok, baseUrl: "not a url" }), /baseUrl/);
  });

  test("rejects an empty model name", () => {
    assert.throws(() => validateModelInput({ ...ok, model: "   " }), /model/);
  });

  test("defaults the label to the id", () => {
    assert.equal(validateModelInput({ ...ok, label: undefined }).label, "my-model");
  });
});

describe("findModel", () => {
  const entries = [
    { id: "a", model: "gpt-a" },
    { id: "b", model: "gpt-b" },
  ];

  test("matches by id first, then by model name", () => {
    assert.equal(findModel(entries, "a").id, "a");
    assert.equal(findModel(entries, "gpt-b").id, "b");
  });

  test("returns undefined for unknown models", () => {
    assert.equal(findModel(entries, "nope"), undefined);
  });
});

describe("loadModels", () => {
  test("merges local overrides and hides removed built-ins", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        models: [
          { id: "a", baseUrl: "https://a/v1", model: "a" },
          { id: "b", baseUrl: "https://b/v1", model: "b" },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "models.local.json"),
      JSON.stringify({
        models: [
          { id: "a", label: "Renamed", baseUrl: "https://a/v1", model: "a2" },
          { id: "b", baseUrl: "https://b/v1", model: "b", hidden: true },
          { id: "c", baseUrl: "https://c/v1", model: "c", requiresKey: false },
        ],
      }),
    );

    const catalog = loadModels(dir);
    const ids = catalog.entries.map((e) => e.id);
    assert.deepEqual(ids, ["a", "c"], "b must be hidden, c appended");
    assert.equal(catalog.entries[0].model, "a2");
    assert.equal(catalog.entries[0].editable, true);
    assert.equal(catalog.entries[1].editable, true);
  });

  test("survives a corrupt models.json", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "models.json"), "{ not json");
    const catalog = loadModels(dir);
    assert.ok(catalog.entries.length > 0, "should fall back to built-ins");
    assert.ok(catalog.warnings.length > 0);
  });
});

/* ---------------- memory ---------------- */

describe("memory search", () => {
  test("ranks and returns matching chunks", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Memory\n\n- user prefers pnpm over npm\n");
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "memory", "2026-10-20.md"),
      "# notes\n\n- deployed the api to staging\n",
    );

    const files = memoryFiles(dir, dir);
    const hits = searchMemory("pnpm", files);
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /pnpm/);
    assert.ok(hits[0].score > 0);
  });

  test("returns nothing for an unrelated query", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- user prefers pnpm\n");
    assert.equal(searchMemory("kubernetes", memoryFiles(dir, dir)).length, 0);
  });

  test("caps results by limit", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "MEMORY.md"),
      Array.from({ length: 30 }, (_, i) => `- pnpm note ${i}`).join("\n"),
    );
    assert.ok(searchMemory("pnpm", memoryFiles(dir, dir), { limit: 3 }).length <= 3);
  });
});

/* ---------------- config parsing ---------------- */

describe("parseDotEnv", () => {
  test("parses keys, quotes and comments", () => {
    const env = parseDotEnv(
      ["# comment", 'A=1', 'B="two words"', "C='single'", "", "INVALID", "D= x "].join("\n"),
    );
    assert.deepEqual(env, { A: "1", B: "two words", C: "single", D: "x" });
  });
});

/* ---------------- wire format ---------------- */

describe("wire format", () => {
  test("keeps tool_calls and tool_call_id", () => {
    const wire = wireMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", name: "read_file", content: "ok" },
    ]);
    assert.equal(wire[1].tool_calls[0].id, "c1");
    assert.equal(wire[2].tool_call_id, "c1");
  });

  test("wraps tools in the OpenAI envelope", () => {
    const wire = wireTools([
      { name: "x", description: "d", parameters: { type: "object", properties: {} } },
    ]);
    assert.equal(wire[0].type, "function");
    assert.equal(wire[0].function.name, "x");
  });
});

/* ---------------- system prompt ---------------- */

describe("buildSystemPrompt", () => {
  test("includes workspace, memory and skills", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".tsagent", "memory"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".tsagent", "MEMORY.md"), "- user likes tests\n");

    const prompt = buildSystemPrompt({
      config: {
        baseUrl: "https://x/v1",
        apiKey: "k",
        model: "m",
        temperature: 0,
        maxIterations: 1,
        maxTokens: undefined,
        workspace: dir,
        homeDir: path.join(dir, ".tsagent"),
        autoApprove: false,
      },
      skills: [{ name: "demo", description: "A demo skill", dir: ".", entry: "SKILL.md" }],
      now: new Date("2026-10-20T00:00:00Z"),
    });

    assert.ok(prompt.includes(dir), "workspace path");
    assert.ok(prompt.includes("user likes tests"), "memory content");
    assert.ok(prompt.includes("demo: A demo skill"), "skill listing");
    assert.ok(prompt.includes("2026-10-20"), "current date");
  });
});

/* ---------------- permission modes ---------------- */

describe("classifyCommand", () => {
  test("treats read-only commands as safe", () => {
    for (const cmd of [
      "ls -la",
      "dir",
      "cat README.md",
      "git status",
      "git log --oneline",
      "npm test",
      "npm run build",
      "node -v",
      "pwd",
    ]) {
      assert.equal(classifyCommand(cmd), "safe", cmd);
    }
  });

  test("flags destructive and side-effecting commands", () => {
    for (const cmd of [
      "rm -rf node_modules",
      "del /q x",
      "git push origin main",
      "git reset --hard",
      "npm install left-pad",
      "echo hi > out.txt",
      "ls | sh",
      "curl -X POST https://x",
      "chmod +x run.sh",
      "sudo rm x",
      "npm run deploy",
      "",
    ]) {
      assert.equal(classifyCommand(cmd), "dangerous", cmd);
    }
  });

  test("a dangerous fragment anywhere wins", () => {
    assert.equal(classifyCommand("cat a.txt && rm -rf b"), "dangerous");
    assert.equal(classifyCommand("ls; shutdown /s"), "dangerous");
  });

  test("unknown commands are conservative", () => {
    assert.equal(classifyCommand("some-random-binary --flag"), "dangerous");
  });
});

describe("mode resolution", () => {
  test("parses english and chinese aliases", () => {
    assert.equal(parseMode("strict"), "strict");
    assert.equal(parseMode("严格"), "strict");
    assert.equal(parseMode("智能"), "smart");
    assert.equal(parseMode("off"), "off");
    assert.equal(parseMode("auto"), "auto");
    assert.equal(parseMode("nonsense", "strict"), "strict");
    assert.equal(parseMode(undefined, "smart"), "smart");
  });

  test("clamps to the operator ceiling", () => {
    assert.equal(clampMode("auto", "smart"), "smart");
    assert.equal(clampMode("strict", "auto"), "strict");
    assert.equal(clampMode("off", "strict"), "off");
  });

  test("needsApproval follows the mode", () => {
    assert.equal(needsApproval("auto", "rm -rf /"), false);
    assert.equal(needsApproval("strict", "ls"), true);
    assert.equal(needsApproval("smart", "ls"), false);
    assert.equal(needsApproval("smart", "rm -rf /"), true);
    assert.equal(needsApproval("off", "rm -rf /"), false);
  });
});

/* ---------------- uploads ---------------- */

describe("safeFileName", () => {
  test("strips directories and traversal", () => {
    assert.equal(safeFileName("../../etc/passwd"), "passwd");
    assert.equal(safeFileName("C:\\Windows\\system.ini"), "system.ini");
    assert.equal(safeFileName(".bashrc"), "bashrc");
  });

  test("keeps readable names, replaces separators", () => {
    assert.equal(safeFileName("my report (1).txt"), "my_report_1_.txt");
    assert.equal(safeFileName("报告 v2.md"), "报告_v2.md");
  });

  test("falls back for empty input", () => {
    assert.equal(safeFileName(""), "file");
  });
});

describe("classifyFile", () => {
  test("detects images", () => {
    assert.equal(classifyFile("a.png", "image/png"), "image");
    assert.equal(classifyFile("photo.JPG", ""), "image");
  });

  test("detects text and code", () => {
    assert.equal(classifyFile("notes.md", "text/markdown"), "text");
    assert.equal(classifyFile("main.ts", ""), "text");
    assert.equal(classifyFile("data.json", "application/json"), "text");
  });

  test("falls back to binary", () => {
    assert.equal(classifyFile("app.exe", "application/octet-stream"), "binary");
    assert.equal(classifyFile("archive.zip", ""), "binary");
  });
});

describe("parseMultipart", () => {
  const boundary = "----test-boundary";

  function build(parts) {
    const chunks = [];
    for (const p of parts) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
            `Content-Type: ${p.type}\r\n\r\n`,
        ),
      );
      chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
  }

  test("reads the boundary from a content-type header", () => {
    assert.equal(boundaryOf(`multipart/form-data; boundary=${boundary}`), boundary);
    assert.equal(boundaryOf("application/json"), undefined);
  });

  test("extracts a single text file", () => {
    const parts = parseMultipart(build([{ name: "file", filename: "a.txt", type: "text/plain", data: "hello" }]), boundary);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].filename, "a.txt");
    assert.equal(parts[0].contentType, "text/plain");
    assert.equal(parts[0].data.toString("utf8"), "hello");
  });

  test("extracts multiple files and keeps binary bytes intact", () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x0d]);
    const parts = parseMultipart(
      build([
        { name: "file", filename: "one.txt", type: "text/plain", data: "first" },
        { name: "file", filename: "two.bin", type: "application/octet-stream", data: binary },
      ]),
      boundary,
    );
    assert.equal(parts.length, 2);
    assert.equal(parts[0].data.toString("utf8"), "first");
    assert.deepEqual([...parts[1].data], [...binary]);
  });

  test("ignores a body without the boundary", () => {
    assert.deepEqual(parseMultipart(Buffer.from("garbage"), boundary), []);
  });
});
