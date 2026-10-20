import path from "node:path";

export class ToolError extends Error {}

export function resolveInWorkspace(workspace: string, target: unknown, base?: string): string {
  const rel = typeof target === "string" && target.trim() ? target.trim() : ".";
  const root = path.resolve(workspace);
  const resolved = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base ?? root, rel);
  const normRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normTarget = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (normTarget !== normRoot && !normTarget.startsWith(normRoot + path.sep)) {
    throw new ToolError(
      `Path escapes the workspace: ${rel}\nAllowed root: ${root}`,
    );
  }
  return resolved;
}

export function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`Missing required argument "${key}"`);
    return "";
  }
  if (typeof v !== "string") throw new ToolError(`Argument "${key}" must be a string`);
  return v;
}

export function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`Argument "${key}" must be a number`);
  return n;
}

export function boolArg(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(1|true|yes)$/i.test(v);
  return fallback;
}

/** Convert a glob to a RegExp supporting **, * and ?. */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        const slashAfter = normalized[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, process.platform === "win32" ? "i" : "");
}

export function relativeTo(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/") || ".";
}
