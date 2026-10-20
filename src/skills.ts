import fs from "node:fs";
import path from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  entry: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return { meta: {}, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: normalized };
  const head = normalized.slice(3, end);
  const body = normalized.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m && m[1] && m[2] !== undefined) {
      meta[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return { meta, body };
}

function firstParagraph(body: string): string {
  const lines = body.split(/\r?\n/);
  const paragraph: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (paragraph.length) break;
      continue;
    }
    if (t.startsWith("#") && !paragraph.length) continue;
    paragraph.push(t);
    if (paragraph.join(" ").length > 240) break;
  }
  return paragraph.join(" ").slice(0, 300);
}

/** Scan `<dir>/<skill>/SKILL.md` (one level, like QwenPaw skills). */
export function scanSkills(skillsDir: string): SkillInfo[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(skillsDir, e.name);
    const entry = path.join(dir, "SKILL.md");
    if (!fs.existsSync(entry)) continue;
    try {
      const raw = fs.readFileSync(entry, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      skills.push({
        name: meta.name || e.name,
        description: meta.description || firstParagraph(body),
        dir,
        entry,
      });
    } catch {
      /* skip unreadable skill */
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(skills: SkillInfo[], name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  const skill =
    skills.find((s) => s.name.toLowerCase() === wanted) ??
    skills.find((s) => s.name.toLowerCase().startsWith(wanted));
  if (!skill) return undefined;
  return fs.readFileSync(skill.entry, "utf8");
}
