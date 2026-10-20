import fs from "node:fs";
import path from "node:path";

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: import("./types.js").ChatMessage[];
}

function shortId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export class SessionStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  create(title = "untitled"): Session {
    const now = new Date().toISOString();
    return { id: shortId(), title, createdAt: now, updatedAt: now, messages: [] };
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^\w.-]/g, "_")}.json`);
  }

  load(id: string): Session | undefined {
    try {
      const raw = fs.readFileSync(this.file(id), "utf8");
      const parsed = JSON.parse(raw) as Session;
      if (!Array.isArray(parsed.messages)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  save(session: Session): void {
    session.updatedAt = new Date().toISOString();
    if (!session.title || session.title === "untitled") {
      const firstUser = session.messages.find((m) => m.role === "user" && m.content);
      if (firstUser?.content) session.title = firstUser.content.slice(0, 60).replace(/\s+/g, " ");
    }
    fs.writeFileSync(this.file(session.id), JSON.stringify(session, null, 2), "utf8");
  }

  list(): Session[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: Session[] = [];
    for (const name of names) {
      const s = this.load(name.replace(/\.json$/, ""));
      if (s) out.push(s);
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
}
