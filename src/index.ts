#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { Agent } from "./agent.js";
import { loadConfig, describeRuntime, type CliOverrides } from "./config.js";
import { loadMemoryContext } from "./memory.js";
import { parseMode, type PermissionMode } from "./permissions.js";
import { buildSystemPrompt } from "./prompt.js";
import { SessionStore, type Session } from "./session.js";
import { scanSkills } from "./skills.js";
import { createToolRegistry } from "./tools/index.js";
import { banner, c, oneLine, truncate } from "./ui.js";
import type { AgentHooks, ToolResult } from "./types.js";

interface CliArgs {
  once?: string;
  sessionId?: string;
  fresh: boolean;
  listSessions: boolean;
  showHelp: boolean;
  verbose: boolean;
  mode?: string;
  overrides: CliOverrides;
}

const VERSION = "0.1.0";

function parseArgs(argv: string[]): CliArgs {
  const overrides: CliOverrides = {};
  const args: CliArgs = { fresh: false, listSessions: false, showHelp: false, verbose: false, overrides };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "-p":
      case "--print":
      case "--once":
        args.once = [args.once, next()].filter(Boolean).join(" ");
        break;
      case "-s":
      case "--session":
        args.sessionId = next();
        break;
      case "--new":
        args.fresh = true;
        break;
      case "--list-sessions":
        args.listSessions = true;
        break;
      case "-m":
      case "--model":
        overrides.model = next();
        break;
      case "--base-url":
        overrides.baseUrl = next();
        break;
      case "-w":
      case "--workspace":
        overrides.workspace = next();
        break;
      case "-y":
      case "--yes":
        overrides.autoApprove = true;
        break;
      case "--mode":
        args.mode = next();
        break;
      case "--max-iterations":
        overrides.maxIterations = Number(next());
        break;
      case "-v":
      case "--verbose":
        args.verbose = true;
        break;
      case "-h":
      case "--help":
        args.showHelp = true;
        break;
      case "--version":
        console.log(VERSION);
        process.exit(0);
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        rest.push(a);
    }
  }

  if (!args.once && rest.length) args.once = rest.join(" ");
  return args;
}

function helpText(): string {
  return `${c.bold("tsagent")} ${VERSION} — a tiny TypeScript agent with tools, skills and memory

Usage
  tsagent                      interactive REPL
  tsagent "do something"       one-shot: run the prompt and exit
  tsagent -p "..."             same as above
  echo "prompt" | tsagent      read the prompt from stdin

Options
  -s, --session <id>       Resume a stored session
      --new                Start a fresh session (default when none given)
      --list-sessions      List stored sessions and exit
  -m, --model <name>       Override the model
      --base-url <url>     Override the API base URL
  -w, --workspace <dir>    Root the agent may touch (default: cwd)
  -y, --yes                Auto-approve destructive tools (same as --mode auto)
      --mode <m>           Shell policy: off | strict | smart | auto (default: strict)
      --max-iterations <n> Tool-call loop limit (default 16)
  -v, --verbose            Print tool results in full
  -h, --help               Show this help

REPL commands
  /help  /new  /sessions  /memory  /skills  /tools  /verbose  /clear  /exit

Environment / .env
  TSA_API_KEY, TSA_BASE_URL, TSA_MODEL, TSA_TEMPERATURE,
  TSA_MAX_ITERATIONS, TSA_WORKSPACE, TSA_AUTO_APPROVE

Layout (under <workspace>/.tsagent)
  sessions/  memory/  skills/  MEMORY.md  config.json`;
}

function summarizeResult(result: ToolResult, verbose: boolean): string {
  const text = verbose ? result.content : truncate(result.content, 400);
  const lines = text.split(/\r?\n/).slice(0, verbose ? 200 : 12).join("\n");
  return result.isError ? c.red(lines) : c.gray(lines);
}

function printSessions(store: SessionStore, limit = 15): void {
  const sessions = store.list();
  if (!sessions.length) {
    console.log(c.gray("No sessions yet."));
    return;
  }
  for (const s of sessions.slice(0, limit)) {
    console.log(`${s.id}  ${c.gray(s.updatedAt)}  ${s.messages.length} msgs  ${s.title}`);
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(c.red((err as Error).message));
    process.exit(2);
  }

  if (!args.once && !stdin.isTTY && !args.showHelp && !args.listSessions) {
    // Piped input: `echo "summarize README.md" | tsagent`
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    const piped = Buffer.concat(chunks).toString("utf8").trim();
    if (piped) args.once = piped;
  }

  if (args.showHelp) {
    console.log(helpText());
    return;
  }

  const config = loadConfig(args.overrides);
  const store = new SessionStore(path.join(config.homeDir, "sessions"));
  const skills = scanSkills(path.join(config.homeDir, "skills"));

  if (args.listSessions) {
    printSessions(store, 30);
    return;
  }

  const interactive = Boolean(stdin.isTTY) && !args.once;
  let rl: readline.Interface | undefined;
  if (interactive) rl = readline.createInterface({ input: stdin, output: stdout });

  const approve = async (action: string, detail?: string): Promise<boolean> => {
    if (config.autoApprove) return true;
    if (!rl) {
      console.log(c.yellow(`\n[blocked] ${action}: ${oneLine(detail ?? "", 200)}`));
      console.log(c.gray("Non-interactive run: rerun with --yes to allow destructive tools."));
      return false;
    }
    console.log(c.yellow(`\n⚠ ${action}`));
    if (detail) console.log(c.gray(`  ${truncate(detail, 600)}`));
    const answer = (await rl.question(c.yellow("Allow? [y/N] "))).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };

  const systemPrompt = () => buildSystemPrompt({ config, skills });

  // --yes wins over --mode; the CLI defaults to strict.
  const permissionMode: PermissionMode = args.overrides.autoApprove
    ? "auto"
    : parseMode(args.mode, "strict");

  const runSubagent = async (task: string): Promise<string> => {
    const subSession = store.create("subagent");
    const subTools = createToolRegistry({ skills, allowSubagent: false });
    const sub = new Agent({
      config,
      tools: subTools,
      session: subSession,
      store,
      buildSystemPrompt: () =>
        `${systemPrompt()}\n\n## Subagent mode\nYou were spawned to handle one self-contained task. ` +
        `Work autonomously, use tools, and end with a concrete report of what you found or changed. ` +
        `Do not ask questions you can answer yourself.`,
      approve: async ({ action, detail }) => approve(action, detail),
      maxIterations: Math.min(8, config.maxIterations),
      mode: permissionMode,
      hooks: {
        onAssistantText: () => {},
        onToolStart: (name, a) => console.log(c.gray(`  ↳ sub: ${name} ${oneLine(a, 100)}`)),
        onToolEnd: () => {},
      },
    });
    return await sub.run(task);
  };

  const tools = createToolRegistry({ skills, runSubagent });

  let session: Session;
  if (args.sessionId) {
    const existing = store.load(args.sessionId);
    if (!existing) {
      console.error(c.red(`Session not found: ${args.sessionId}`));
      process.exit(1);
    }
    session = existing;
    // Force a fresh system prompt on resume.
    if (session.messages[0]?.role === "system") session.messages.shift();
  } else {
    session = store.create();
  }

  let controller: AbortController | undefined;
  const hooks: AgentHooks = {
    onAssistantText: (text) => {
      console.log(text.trim());
    },
    onToolStart: (name, toolArgs) => {
      console.log(c.blue(`⚙ ${name}`) + c.gray(` ${oneLine(toolArgs, 160)}`));
    },
    onToolEnd: (_name, result) => {
      console.log(`  ${c.gray("→")} ${summarizeResult(result, args.verbose)}`);
    },
  };

  const agent = new Agent({
    config,
    tools,
    session,
    store,
    buildSystemPrompt: systemPrompt,
    hooks,
    approve: async ({ action, detail }) => approve(action, detail),
    subagentRunner: runSubagent,
    mode: permissionMode,
    signal: () => controller?.signal,
  });

  /** Slash commands. Returns false when the REPL should exit. */
  const handleCommand = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    switch ((cmd ?? "").toLowerCase()) {
      case "exit":
      case "quit":
        return false;
      case "help":
        console.log(helpText());
        return true;
      case "new":
        session = store.create();
        agent.setSession(session);
        console.log(c.gray(`New session ${session.id}`));
        return true;
      case "sessions":
        printSessions(store);
        return true;
      case "memory":
        console.log(loadMemoryContext(config.homeDir) || c.gray("Memory is empty."));
        return true;
      case "skills":
        console.log(
          skills.length ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") : c.gray("No skills."),
        );
        return true;
      case "tools":
        console.log([...tools.keys()].join(", "));
        return true;
      case "context": {
        const est = JSON.stringify(agent.messages).length;
        console.log(c.gray(`${agent.messages.length} messages, ~${Math.round(est / 4)} tokens (rough)`));
        return true;
      }
      case "clear":
        console.clear();
        return true;
      case "verbose":
        args.verbose = !args.verbose;
        console.log(c.gray(`verbose=${args.verbose}`));
        return true;
      default:
        console.log(c.gray(`Unknown command /${cmd ?? ""} — try /help`));
        return true;
    }
  };

  const ask = async (prompt: string): Promise<string> => {
    controller = new AbortController();
    try {
      return await agent.run(prompt);
    } catch (err) {
      if ((err as Error).name === "AbortError") return "(interrupted)";
      console.error(c.red(`\n✗ ${(err as Error).message}`));
      return "";
    } finally {
      controller = undefined;
    }
  };

  // One-shot mode (also used for piped input).
  if (args.once) {
    const text = args.once.trim();
    if (text.startsWith("/") && !text.includes("\n")) {
      await handleCommand(text);
      rl?.close();
      return;
    }
    const answer = await ask(text);
    rl?.close();
    if (!answer) process.exit(1);
    return;
  }

  if (interactive) {
    console.log(banner({ model: config.model, workspace: config.workspace, autoApprove: config.autoApprove }));
    if (args.verbose) console.log(c.gray(describeRuntime(config)));
    console.log("");
  }

  while (rl) {
    let line: string;
    try {
      line = (await rl.question(c.cyan("you> "))).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line.startsWith("/")) {
      if (!(await handleCommand(line))) break;
      continue;
    }
    await ask(line);
    console.log("");
  }

  rl?.close();
  if (session.messages.length) console.log(c.gray(`session ${session.id} saved to ${config.homeDir}`));
}

main().catch((err) => {
  console.error(c.red(`Fatal: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
