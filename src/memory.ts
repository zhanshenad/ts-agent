import fs from "node:fs";
import path from "node:path";

export interface MemoryHit {
  file: string;
  line: number;
  snippet: string;
  score: number;
}

const MAX_FILE_BYTES = 256 * 1024;

function listMarkdown(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...listMarkdown(full, depth + 1));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

export function memoryFiles(workspace: string, homeDir: string): string[] {
  const files = new Set<string>();
  const memFile = path.join(homeDir, "MEMORY.md");
  if (fs.existsSync(memFile)) files.add(memFile);
  for (const f of listMarkdown(path.join(homeDir, "memory"))) files.add(f);
  for (const f of listMarkdown(path.join(workspace, "digest"))) files.add(f);
  return [...files];
}

/** Today's diary file inside .tsagent/memory. */
export function dailyNotePath(homeDir: string, date = new Date()): string {
  const iso = date.toISOString().slice(0, 10);
  return path.join(homeDir, "memory", `${iso}.md`);
}

export function appendDailyNote(homeDir: string, text: string, date = new Date()): string {
  const file = dailyNotePath(homeDir, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = fs.existsSync(file);
  const header = exists ? "" : `# ${date.toISOString().slice(0, 10)}\n\n`;
  const stamp = date.toTimeString().slice(0, 5);
  fs.appendFileSync(file, `${header}- ${stamp} ${text.trim()}\n`, "utf8");
  return file;
}

/**
 * What gets injected into the system prompt every turn: the curated MEMORY.md
 * plus a short tail of the most recent daily notes.
 */
export function loadMemoryContext(homeDir: string, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 6000;
  const parts: string[] = [];

  const memFile = path.join(homeDir, "MEMORY.md");
  try {
    const raw = fs.readFileSync(memFile, "utf8").slice(0, Math.floor(maxChars * 0.7));
    if (raw.trim()) parts.push(`### MEMORY.md\n${raw.trim()}`);
  } catch {
    /* no memory yet */
  }

  const notes = listMarkdown(path.join(homeDir, "memory"))
    .filter((f) => !f.endsWith("MEMORY.md"))
    .sort()
    .slice(-3);

  for (const f of notes) {
    try {
      const raw = fs.readFileSync(f, "utf8");
      const tail = raw.slice(-2000).trim();
      if (tail) parts.push(`### ${path.basename(f)}\n${tail}`);
    } catch {
      /* ignore */
    }
  }

  const joined = parts.join("\n\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n...(truncated)` : joined;
}

function tokenize(query: string): string[] {
  const lower = query.toLowerCase();
  const words = lower.split(/[^a-z0-9_+-]+/).filter((w) => w.length > 1);
  const cjk = lower.match(/[\u4e00-\u9fa5]{1,6}/g) ?? [];
  return [...new Set([...words, ...cjk])].slice(0, 24);
}

/** Tiny lexical retriever over the markdown knowledge base (no embeddings). */
export function searchMemory(
  query: string,
  files: string[],
  opts: { limit?: number; chunkLines?: number } = {},
): MemoryHit[] {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const limit = opts.limit ?? 5;
  const chunkLines = opts.chunkLines ?? 12;
  const hits: MemoryHit[] = [];

  for (const file of files) {
    let raw: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += chunkLines) {
      const chunk = lines.slice(i, i + chunkLines).join("\n");
      const lower = chunk.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        const idx = lower.indexOf(t);
        if (idx !== -1) score += 1 + Math.min(3, countOccurrences(lower, t));
      }
      if (!score) continue;
      // Favour headings and files named after the query.
      if (/^#{1,6}\s/.test(chunk)) score += 1;
      if (path.basename(file).toLowerCase().includes(tokens[0] ?? "")) score += 1;
      hits.push({ file, line: i + 1, snippet: chunk.trim().slice(0, 700), score });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && count < 10) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
