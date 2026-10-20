import type { SkillInfo } from "../skills.js";
import type { Tool, ToolRegistry } from "../types.js";
import { fileTools } from "./fs.js";
import { memoryTools } from "./memory.js";
import { makeSkillTool } from "./skill.js";
import { shellTool } from "./shell.js";
import { webFetchTool } from "./web.js";

export interface RegistryOptions {
  skills: SkillInfo[];
  /** Runs a self-contained subagent task and returns its final answer. */
  runSubagent?: (task: string) => Promise<string>;
  /** Set false inside subagents to avoid unbounded recursion. */
  allowSubagent?: boolean;
}

function makeSubagentTool(run: (task: string) => Promise<string>): Tool {
  return {
    spec: {
      name: "spawn_subagent",
      description:
        "Delegate a self-contained task to a fresh subagent with its own context. It has the same tools (no nested subagents) and returns only its final answer. Use for research, bulk file work, or anything that would flood this conversation.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Complete, standalone instructions: goal, inputs (paths/URLs), expected output format.",
          },
        },
        required: ["task"],
      },
    },
    async run(args) {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) return { content: "task must be a non-empty string", isError: true };
      try {
        const answer = await run(task);
        return { content: answer || "(subagent returned an empty answer)" };
      } catch (err) {
        return { content: `Subagent failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

export function createToolRegistry(opts: RegistryOptions): ToolRegistry {
  const registry: ToolRegistry = new Map();
  const add = (tools: Tool[]) => {
    for (const t of tools) registry.set(t.spec.name, t);
  };

  add(fileTools);
  add([shellTool, webFetchTool]);
  add(memoryTools);
  add([makeSkillTool(opts.skills)]);
  if (opts.allowSubagent !== false && opts.runSubagent) {
    registry.set("spawn_subagent", makeSubagentTool(opts.runSubagent));
  }
  return registry;
}
