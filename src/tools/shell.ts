import { exec } from "node:child_process";
import { needsApproval } from "../permissions.js";
import type { Tool } from "../types.js";
import { numArg, relativeTo, resolveInWorkspace, str } from "./common.js";

const MAX_OUTPUT = 20_000;

export const shellTool: Tool = {
  destructive: true,
  spec: {
    name: "shell",
    description:
      "Run a shell command (cmd.exe on Windows, /bin/sh elsewhere) inside the workspace and return stdout, stderr and the exit code. Long output is truncated.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." },
        cwd: { type: "string", description: "Working directory, relative to the workspace." },
        timeout: { type: "number", description: "Timeout in seconds (default 120, max 600)." },
      },
      required: ["command"],
    },
  },
  async run(args, ctx) {
    const command = str(args, "command");
    const cwd = resolveInWorkspace(ctx.workspace, str(args, "cwd", false) || ".");
    const timeout = Math.min(600, Math.max(1, numArg(args, "timeout") ?? 120)) * 1000;

    const mode = ctx.mode ?? "strict";
    if (mode === "off") {
      return {
        content:
          "Shell is disabled (permission mode `off`). Use the file tools instead, or ask the user to enable a shell mode.",
        isError: true,
      };
    }

    if (needsApproval(mode, command)) {
      const approved = await ctx.approve("run shell command", command);
      if (!approved) {
        return {
          content:
            "Command was NOT executed: the user denied approval. Explain what you wanted to run and ask them to run it, or try a non-shell approach.",
          isError: true,
        };
      }
    }

    return await new Promise((resolve) => {
      exec(
        command,
        { cwd, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true, shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh" },
        (err, stdout, stderr) => {
          const parts: string[] = [];
          parts.push(`$ ${command}`);
          parts.push(`(in ${relativeTo(ctx.workspace, cwd)})`);
          if (stdout.trim()) parts.push(`--- stdout ---\n${clip(stdout)}`);
          if (stderr.trim()) parts.push(`--- stderr ---\n${clip(stderr)}`);
          if (err && typeof (err as { code?: unknown }).code === "number") {
            parts.push(`exit code: ${(err as { code?: number }).code}`);
          } else if (err) {
            parts.push(`error: ${(err as Error).message}`);
          } else {
            parts.push("exit code: 0");
          }
          resolve({ content: parts.join("\n"), isError: Boolean(err) });
        },
      );
    });
  },
};

function clip(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.length <= MAX_OUTPUT) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT)}\n...(truncated ${trimmed.length - MAX_OUTPUT} chars)`;
}
