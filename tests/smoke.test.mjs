/**
 * End-to-end smoke test with a fake OpenAI-compatible server.
 * No API key or network needed: `npm test`
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
const cli = path.join(root, "dist", "index.js");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tsagent-ws-"));
const home = path.join(workspace, ".tsagent");
fs.mkdirSync(path.join(home, "skills", "demo"), { recursive: true });
fs.writeFileSync(
  path.join(home, "skills", "demo", "SKILL.md"),
  `---\nname: demo\ndescription: A demo skill used by the smoke test.\n---\n\n# Demo skill\n\nDemo skill body marker: ZEBRA-42.\n`,
  "utf8",
);

const steps = [
  { tool: "write_file", args: { path: "hello.txt", content: "hi from tool\n" } },
  { tool: "skill", args: { name: "demo" } },
  { tool: "memory_append", args: { text: "user likes tests", target: "memory" } },
  { final: "DONE: wrote hello.txt, loaded skill demo, saved memory." },
];

let callIndex = 0;
const seen = { systemPrompt: "", toolMessages: [] };

/** Decide the next mock reply from the conversation so far. */
function pickStep(messages) {
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content ?? "")
    .join(" ");
  if (/shell command/i.test(userText)) {
    const denied = messages.some((m) => m.role === "tool" && /NOT executed/.test(m.content ?? ""));
    if (denied) return { final: "I could not run it without approval." };
    const alreadyRan = messages.some((m) => m.role === "tool" && /exit code:/.test(m.content ?? ""));
    if (alreadyRan) return { final: "Ran the shell command." };
    return { tool: "shell", args: { command: "echo SHOULD_NOT_RUN > shell_probe.txt" } };
  }
  return steps[Math.min(callIndex, steps.length - 1)];
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const messages = payload.messages ?? [];
    seen.systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
    seen.toolMessages = messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.ok(Array.isArray(payload.tools) && payload.tools.length > 5, "tools should be advertised");

    const step = pickStep(messages);
    callIndex++;

    const message =
      step.final !== undefined
        ? { role: "assistant", content: step.final }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${callIndex}`,
                type: "function",
                function: { name: step.tool, arguments: JSON.stringify(step.args) },
              },
            ],
          };

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${callIndex}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "mock",
        choices: [
          {
            index: 0,
            message,
            finish_reason: step.final !== undefined ? "stop" : "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
});

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: workspace,
      env: { ...process.env, ...env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const env = {
    TSA_API_KEY: "test-key",
    TSA_BASE_URL: `http://127.0.0.1:${port}/v1`,
    TSA_MODEL: "mock",
    TSA_MAX_ITERATIONS: "8",
  };

  // 1. Full tool-calling loop, non-interactive + auto-approved
  const r = await runCli(["-p", "please do the thing", "-y"], env);
  assert.equal(r.code, 0, `CLI failed:\n${r.stderr}`);

  const answer = steps.at(-1).final;
  assert.ok(r.stdout.includes(answer), `final answer missing from stdout:\n${r.stdout}`);

  const helloPath = path.join(workspace, "hello.txt");
  assert.ok(fs.existsSync(helloPath), "write_file should have created hello.txt");
  assert.equal(fs.readFileSync(helloPath, "utf8"), "hi from tool\n");

  assert.ok(
    seen.systemPrompt.includes("demo"),
    "system prompt should list the installed skill",
  );
  assert.ok(
    seen.toolMessages.some((m) => m.includes("ZEBRA-42")),
    "skill tool should have returned the SKILL.md body",
  );

  assert.ok(
    fs.readFileSync(path.join(home, "MEMORY.md"), "utf8").includes("user likes tests"),
    "memory_append should persist to MEMORY.md",
  );

  const sessions = fs.readdirSync(path.join(home, "sessions"));
  assert.ok(sessions.length >= 1, "session should be persisted");
  const saved = JSON.parse(fs.readFileSync(path.join(home, "sessions", sessions[0]), "utf8"));
  assert.ok(
    saved.messages.some((m) => m.role === "tool" && m.tool_call_id),
    "tool messages should be stored with tool_call_id",
  );
  assert.ok(!saved.messages.some((m) => m.role === "tool" && !m.tool_call_id), "no orphan tool msgs");

  // 2. Approval gate: shell must be refused without --yes in non-interactive mode
  const denied = await runCli(["-p", "run a shell command"], env);
  assert.equal(denied.code, 0, `CLI failed:\n${denied.stderr}`);
  assert.ok(
    denied.stdout.includes("[blocked]") || denied.stdout.includes("NOT executed"),
    `shell should have been blocked:\n${denied.stdout}`,
  );
  assert.ok(
    !fs.existsSync(path.join(workspace, "shell_probe.txt")),
    "blocked shell command must not have run",
  );

  // 2b. With --yes the same command is approved and really runs
  const ran = await runCli(["-p", "run a shell command", "-y"], env);
  assert.equal(ran.code, 0, `CLI failed:\n${ran.stderr}`);
  const probe = path.join(workspace, "shell_probe.txt");
  assert.ok(fs.existsSync(probe), "approved shell command should have run");
  assert.ok(/SHOULD_NOT_RUN/.test(fs.readFileSync(probe, "utf8")), "shell stdout should be captured");

  // 3. Sandbox: file tools cannot escape the workspace
  const { fileTools } = await import(pathToFileURL(path.join(root, "dist", "tools", "fs.js")).href);
  const readTool = fileTools.find((t) => t.spec.name === "read_file");
  let escaped = false;
  try {
    await readTool.run(
      { path: path.join(workspace, "..", "outside.txt") },
      { workspace, homeDir: home, sessionId: "t", approve: async () => true, log: () => {} },
    );
  } catch (err) {
    escaped = /escapes the workspace/i.test(err.message);
  }
  assert.ok(escaped, "read_file must reject paths outside the workspace");

  // 4. edit_file + grep round trip
  const writeTool = fileTools.find((t) => t.spec.name === "write_file");
  const editTool = fileTools.find((t) => t.spec.name === "edit_file");
  const grepTool = fileTools.find((t) => t.spec.name === "grep");
  const ctx = { workspace, homeDir: home, sessionId: "t", approve: async () => true, log: () => {} };
  await writeTool.run({ path: "src/a.ts", content: "const alpha = 1;\nconst beta = 2;\n" }, ctx);
  await editTool.run({ path: "src/a.ts", old_text: "beta = 2", new_text: "beta = 3" }, ctx);
  const grep = await grepTool.run({ pattern: "beta", path: "src" }, ctx);
  assert.ok(grep.content.includes("beta = 3"), `grep result unexpected:\n${grep.content}`);

  console.log("\n✅ all smoke tests passed");
  console.log(`   workspace: ${workspace}`);
  server.close();
}

main().catch((err) => {
  console.error("\n❌ smoke test failed:", err);
  server.close();
  process.exit(1);
});
