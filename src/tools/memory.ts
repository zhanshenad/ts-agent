import fs from "node:fs";
import path from "node:path";
import { appendDailyNote, memoryFiles, searchMemory } from "../memory.js";
import type { Tool } from "../types.js";
import { numArg, str } from "./common.js";

const memorySearchTool: Tool = {
  spec: {
    name: "memory_search",
    description:
      "Search long-term memory (MEMORY.md, daily notes, digest/*.md) with a lexical/keyword query. Use it before answering anything about the user's past work, preferences or decisions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, not a full sentence." },
        limit: { type: "number", description: "Max snippets (default 5)." },
      },
      required: ["query"],
    },
  },
  async run(args, ctx) {
    const query = str(args, "query");
    const limit = Math.min(20, Math.max(1, numArg(args, "limit") ?? 5));
    const files = memoryFiles(ctx.workspace, ctx.homeDir);
    if (!files.length) return { content: "Memory is empty — nothing stored yet." };

    const hits = searchMemory(query, files, { limit });
    if (!hits.length) {
      return { content: `No memory entries matched "${query}" (searched ${files.length} file(s)).` };
    }
    const blocks = hits.map((h) => {
      const display = path.relative(ctx.workspace, h.file) || h.file;
      return `### ${display}:${h.line} (score ${h.score})\n${h.snippet}`;
    });
    return { content: blocks.join("\n\n") };
  },
};

const memoryAppendTool: Tool = {
  spec: {
    name: "memory_append",
    description:
      "Store a durable fact. target='memory' appends to MEMORY.md (preferences, decisions, standing facts); target='daily' appends to today's diary (what happened today). Never store secrets or credentials.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "One concise line, e.g. 'user prefers pnpm over npm'." },
        target: { type: "string", enum: ["memory", "daily"], description: "Default: memory." },
      },
      required: ["text"],
    },
  },
  async run(args, ctx) {
    const text = str(args, "text").trim();
    const target = (str(args, "target", false) || "memory").toLowerCase();

    if (target === "daily") {
      const file = appendDailyNote(ctx.homeDir, text);
      return { content: `Saved to ${path.relative(ctx.workspace, file)}` };
    }

    const file = path.join(ctx.homeDir, "MEMORY.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "# Memory\n\n", "utf8");
    fs.appendFileSync(file, `- ${text}\n`, "utf8");
    return { content: `Saved to ${path.relative(ctx.workspace, file)}` };
  },
};

export const memoryTools: Tool[] = [memorySearchTool, memoryAppendTool];
