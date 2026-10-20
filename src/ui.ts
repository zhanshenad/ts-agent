/** ANSI helpers — degrade to plain text when the terminal does not cooperate. */

const enabled = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

function wrap(code: string, text: string): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const c = {
  dim: (t: string) => wrap("2", t),
  bold: (t: string) => wrap("1", t),
  red: (t: string) => wrap("31", t),
  green: (t: string) => wrap("32", t),
  yellow: (t: string) => wrap("33", t),
  blue: (t: string) => wrap("34", t),
  magenta: (t: string) => wrap("35", t),
  cyan: (t: string) => wrap("36", t),
  gray: (t: string) => wrap("90", t),
};

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (${text.length - max} more chars)`;
}

export function oneLine(value: unknown, max = 120): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return truncate((raw ?? "").replace(/\s+/g, " "), max);
}

export function banner(cfg: { model: string; workspace: string; autoApprove: boolean }): string {
  return [
    c.bold("TsAgent"),
    c.gray(`model=${cfg.model}  workspace=${cfg.workspace}`),
    c.gray(
      cfg.autoApprove
        ? "auto-approve ON — shell runs without asking"
        : "shell commands will ask for approval",
    ),
    c.gray("commands: /help  /new  /sessions  /memory  /skills  /exit"),
  ].join("\n");
}
