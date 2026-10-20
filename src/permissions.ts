/**
 * Shell permission model.
 *
 *   off     — shell disabled entirely
 *   strict  — every command needs approval
 *   smart   — read-only commands run, anything else needs approval
 *   auto    — everything runs (only when the server operator allows it)
 */

export type PermissionMode = "off" | "strict" | "smart" | "auto";

const RANK: Record<PermissionMode, number> = { off: 0, strict: 1, smart: 2, auto: 3 };

const ALIASES: Record<string, PermissionMode> = {
  off: "off",
  disabled: "off",
  none: "off",
  strict: "strict",
  smart: "smart",
  auto: "auto",
  yolo: "auto",
  yes: "auto",
  关闭: "off",
  禁用: "off",
  严格: "strict",
  智能: "smart",
  自动: "auto",
};

export const ALL_MODES: PermissionMode[] = ["off", "strict", "smart", "auto"];

export function isMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (ALL_MODES as string[]).includes(value);
}

export function parseMode(value: unknown, fallback: PermissionMode = "smart"): PermissionMode {
  if (typeof value !== "string") return fallback;
  return ALIASES[value.trim().toLowerCase()] ?? fallback;
}

export function modeRank(mode: PermissionMode): number {
  return RANK[mode];
}

/** Never let a caller ask for more power than the operator granted. */
export function clampMode(requested: PermissionMode, max: PermissionMode): PermissionMode {
  return RANK[requested] > RANK[max] ? max : requested;
}

/* ------------------------------------------------------------------ */
/* command classification                                             */
/* ------------------------------------------------------------------ */

/** Anything matching here is destructive, side-effecting, or network-write. */
const DANGEROUS: RegExp[] = [
  /\brm\b/i,
  /\bdel\b/i,
  /\brmdir\b/i,
  /\brd\s+\/s/i,
  /\bRemove-Item\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\btaskkill\b/i,
  /\bkill(all)?\b/i,
  /\bpkill\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bicacls\b/i,
  /\btakeown\b/i,
  /\bgit\s+(push|reset|clean|rebase|filter-branch|checkout\s+--)/i,
  /\bgit\s+commit\b/i,
  /\bnpm\s+(publish|install|i|uninstall|update)\b/i,
  /\byarn\s+(add|remove|global)\b/i,
  /\bpnpm\s+(add|remove|install)\b/i,
  /\bpip3?\s+install\b/i,
  /\bcurl\b[^|]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|--upload-file|-d\s)/i,
  /\bwget\b[^|]*(--post|--body-file)/i,
  /\|\s*(sh|bash|zsh|powershell|pwsh|cmd)\b/i,
  /\bsudo\b/i,
  /\brunas\b/i,
  /\bInvoke-Expression\b/i,
  /\bIEX\b/i,
  /\bmv\b/i,
  /\bcp\s+-r/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /(^|[^2&])>\s*[^&|]/,
];

/** Commands that only read. Anything not listed here is treated as dangerous. */
const SAFE: RegExp[] = [
  /^ls(\s|$)/,
  /^dir(\s|$)/i,
  /^pwd$/,
  /^echo\s/i,
  /^cat\s/i,
  /^type\s/i,
  /^head(\s|$)/i,
  /^tail(\s|$)/i,
  /^wc(\s|$)/i,
  /^grep\s/i,
  /^rg\s/i,
  /^find\s/i,
  /^where\s/i,
  /^which\s/i,
  /^git\s+(status|log|diff|show|branch|remote\s+-v)(\s|$)/i,
  /^node\s+(-v|--version)$/i,
  /^npm\s+(-v|--version)$/i,
  /^npm\s+test(\s|$)/i,
  /^npm\s+run\s+(test|build|typecheck|lint|dev:web)(\s|$)/i,
  /^npx\s+tsc\s+--noEmit/i,
  /^tsc\s+--noEmit/i,
  /^python3?\s+--version$/i,
  /^whoami$/i,
  /^date$/i,
  /^df(\s|$)/i,
  /^free(\s|$)/i,
  /^ver$/i,
  /^set$/i,
  /^cd\s+[^&|;]+$/,
];

export function classifyCommand(command: string): "safe" | "dangerous" {
  const cmd = String(command ?? "").trim();
  if (!cmd) return "dangerous";

  // A dangerous fragment anywhere (including after ; | &&) wins.
  for (const re of DANGEROUS) {
    if (re.test(cmd)) return "dangerous";
  }
  // Only a whole-string match on the allow-list counts as safe.
  for (const re of SAFE) {
    if (re.test(cmd)) return "safe";
  }
  return "dangerous";
}

/** Whether a tool call needs a human answer under the given mode. */
export function needsApproval(mode: PermissionMode, command: string): boolean {
  if (mode === "off") return false; // it won't run at all
  if (mode === "auto") return false;
  if (mode === "strict") return true;
  return classifyCommand(command) === "dangerous";
}
