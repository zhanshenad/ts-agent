import fs from "node:fs";
import path from "node:path";
import type { Tool } from "../types.js";
import { globToRegExp, numArg, relativeTo, resolveInWorkspace, str, ToolError } from "./common.js";

const MAX_READ_CHARS = 200_000;
const MAX_OUTPUT = 60_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

function walk(root: string, maxFiles = 5000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

const readFile: Tool = {
  spec: {
    name: "read_file",
    description:
      "Read a text file with line numbers. Use start_line/end_line to page through large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace." },
        start_line: { type: "number", description: "1-based first line (optional)." },
        end_line: { type: "number", description: "Last line, inclusive (optional)." },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const file = resolveInWorkspace(ctx.workspace, str(args, "path"));
    let raw: string;
    try {
      const stat = fs.statSync(file);
      if (stat.isDirectory()) throw new ToolError(`${file} is a directory; use list_dir`);
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new ToolError(`Cannot read ${file}: ${(err as Error).message}`);
    }
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, numArg(args, "start_line") ?? 1);
    const end = Math.min(lines.length, numArg(args, "end_line") ?? start + 400);
    const slice = lines.slice(start - 1, end);
    let body = slice.map((l, i) => `${start + i}: ${l}`).join("\n");
    let note = "";
    if (body.length > MAX_READ_CHARS) {
      body = body.slice(0, MAX_READ_CHARS);
      note = "\n... truncated; read a narrower line range";
    }
    return {
      content:
        `${relativeTo(ctx.workspace, file)} (${lines.length} lines, showing ${start}-${end})\n` +
        `---\n${body}${note}`,
    };
  },
};

const writeFile: Tool = {
  spec: {
    name: "write_file",
    description: "Create or overwrite a file. Parent directories are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
    },
  },
  async run(args, ctx) {
    const file = resolveInWorkspace(ctx.workspace, str(args, "path"));
    const content = str(args, "content");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existed = fs.existsSync(file);
    fs.writeFileSync(file, content, "utf8");
    return {
      content: `${existed ? "Overwrote" : "Created"} ${relativeTo(ctx.workspace, file)} (${content.length} chars, ${content.split(/\r?\n/).length} lines)`,
    };
  },
};

const editFile: Tool = {
  spec: {
    name: "edit_file",
    description:
      "Replace every exact occurrence of old_text with new_text in a file. Fails if old_text is absent.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace." },
        old_text: { type: "string", description: "Exact text to find (include enough context)." },
        new_text: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  async run(args, ctx) {
    const file = resolveInWorkspace(ctx.workspace, str(args, "path"));
    const oldText = str(args, "old_text");
    const newText = str(args, "new_text");
    if (!oldText) throw new ToolError("old_text must not be empty");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new ToolError(`Cannot read ${file}: ${(err as Error).message}`);
    }
    if (!raw.includes(oldText)) {
      throw new ToolError(
        `old_text not found in ${relativeTo(ctx.workspace, file)}. Read the file again and copy the exact text.`,
      );
    }
    const occurrences = raw.split(oldText).length - 1;
    fs.writeFileSync(file, raw.split(oldText).join(newText), "utf8");
    return {
      content: `Replaced ${occurrences} occurrence(s) in ${relativeTo(ctx.workspace, file)}`,
    };
  },
};

const listDir: Tool = {
  spec: {
    name: "list_dir",
    description: "List directory entries. Directories end with a slash.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory, relative to the workspace. Default: workspace root." },
      },
    },
  },
  async run(args, ctx) {
    const dir = resolveInWorkspace(ctx.workspace, str(args, "path", false) || ".");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new ToolError(`Cannot list ${dir}: ${(err as Error).message}`);
    }
    if (!entries.length) return { content: `${relativeTo(ctx.workspace, dir)} is empty` };
    const lines = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => {
        if (e.isDirectory()) return `${e.name}/`;
        try {
          const size = fs.statSync(path.join(dir, e.name)).size;
          return `${e.name}  (${size} B)`;
        } catch {
          return e.name;
        }
      });
    return { content: `${relativeTo(ctx.workspace, dir)}:\n${lines.join("\n")}` };
  },
};

const globTool: Tool = {
  spec: {
    name: "glob",
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test?.md".',
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern." },
        path: { type: "string", description: "Directory to search from. Default: workspace root." },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = str(args, "pattern");
    const root = resolveInWorkspace(ctx.workspace, str(args, "path", false) || ".");
    const regex = globToRegExp(pattern);
    const matches = walk(root)
      .map((f) => relativeTo(ctx.workspace, f))
      .filter((rel) => regex.test(rel) || regex.test(path.basename(rel)))
      .slice(0, 300);
    if (!matches.length) return { content: `No files matched ${pattern}` };
    return { content: `${matches.length} match(es):\n${matches.join("\n")}` };
  },
};

const grepTool: Tool = {
  spec: {
    name: "grep",
    description: "Search file contents recursively. Returns path:line: content, like grep -rn.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regular expression." },
        path: { type: "string", description: "File or directory. Default: workspace root." },
        is_regex: { type: "boolean", description: "Treat pattern as a RegExp. Default false." },
        case_sensitive: { type: "boolean", description: "Default false." },
        include: { type: "string", description: 'Only files whose name matches this glob, e.g. "*.ts".' },
        context_lines: { type: "number", description: "Lines of context before/after each hit (0-5)." },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = str(args, "pattern");
    const target = resolveInWorkspace(ctx.workspace, str(args, "path", false) || ".");
    const isRegex = args.is_regex === true || String(args.is_regex) === "true";
    const caseSensitive = args.case_sensitive === true || String(args.case_sensitive) === "true";
    const include = str(args, "include", false);
    const ctxLines = Math.max(0, Math.min(5, numArg(args, "context_lines") ?? 0));

    let matcher: RegExp;
    try {
      matcher = new RegExp(isRegex ? pattern : escapeRegExp(pattern), caseSensitive ? "" : "i");
    } catch (err) {
      throw new ToolError(`Invalid regex: ${(err as Error).message}`);
    }
    const includeRe = include ? globToRegExp(include) : undefined;

    const files = fs.existsSync(target) && fs.statSync(target).isFile() ? [target] : walk(target);
    const out: string[] = [];
    let fileGroups = 0;

    for (const file of files) {
      if (includeRe && !includeRe.test(path.basename(file))) continue;
      let raw: string;
      try {
        const stat = fs.statSync(file);
        if (stat.size > 2_000_000) continue;
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (raw.includes("\u0000")) continue; // binary
      const lines = raw.split(/\r?\n/);
      const hits: number[] = [];
      for (let i = 0; i < lines.length; i++) if (matcher.test(lines[i]!)) hits.push(i);
      if (!hits.length) continue;
      fileGroups++;
      out.push(`--- ${relativeTo(ctx.workspace, file)}`);
      const shown = new Set<number>();
      for (const h of hits.slice(0, 20)) {
        for (let i = Math.max(0, h - ctxLines); i <= Math.min(lines.length - 1, h + ctxLines); i++) {
          if (shown.has(i)) continue;
          shown.add(i);
          out.push(`${i + 1}:${i === h ? ">" : " "} ${lines[i]}`);
        }
      }
      if (out.join("\n").length > MAX_OUTPUT) break;
    }

    if (!out.length) return { content: `No matches for ${pattern}` };
    let text = out.join("\n");
    if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n...(truncated)`;
    return { content: `${fileGroups} file(s) matched\n${text}` };
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const fileTools: Tool[] = [readFile, writeFile, editFile, listDir, globTool, grepTool];
