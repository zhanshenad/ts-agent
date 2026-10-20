import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxIterations: number;
  maxTokens: number | undefined;
  workspace: string;
  homeDir: string;
  autoApprove: boolean;
}

export interface CliOverrides {
  model?: string;
  baseUrl?: string;
  workspace?: string;
  autoApprove?: boolean;
  maxIterations?: number;
}

const HOME_DIRNAME = ".tsagent";

/** Minimal dotenv parser: KEY=VALUE, # comments, optional quotes. */
export function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function readEnvFile(file: string): Record<string, string> {
  try {
    return parseDotEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function readJsonFile(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value);
  return fallback;
}

export function loadConfig(overrides: CliOverrides = {}): Config {
  const cwd = process.cwd();
  const workspace = path.resolve(
    overrides.workspace ?? process.env.TSA_WORKSPACE ?? cwd,
  );
  const homeDir = path.resolve(workspace, HOME_DIRNAME);

  // Precedence: real env > workspace/.env > workspace/.tsagent/config.json > defaults
  const envFile = readEnvFile(path.join(workspace, ".env"));
  const jsonFile = readJsonFile(path.join(homeDir, "config.json"));
  const pick = (envKey: string, jsonKey: string, fallback: string): string => {
    return (
      process.env[envKey] ??
      envFile[envKey] ??
      (jsonFile[jsonKey] !== undefined ? String(jsonFile[jsonKey]) : undefined) ??
      fallback
    );
  };

  const apiKey = pick("TSA_API_KEY", "apiKey", "");
  const config: Config = {
    baseUrl: overrides.baseUrl ?? pick("TSA_BASE_URL", "baseUrl", "https://api.openai.com/v1"),
    apiKey,
    model: overrides.model ?? pick("TSA_MODEL", "model", "gpt-4o-mini"),
    temperature: num(process.env.TSA_TEMPERATURE ?? envFile.TSA_TEMPERATURE ?? jsonFile.temperature, 0.3),
    maxIterations:
      overrides.maxIterations ??
      num(process.env.TSA_MAX_ITERATIONS ?? envFile.TSA_MAX_ITERATIONS ?? jsonFile.maxIterations, 16),
    maxTokens: jsonFile.maxTokens === undefined ? undefined : num(jsonFile.maxTokens, 2048),
    workspace,
    homeDir,
    autoApprove:
      overrides.autoApprove ??
      bool(process.env.TSA_AUTO_APPROVE ?? envFile.TSA_AUTO_APPROVE ?? jsonFile.autoApprove, false),
  };

  fs.mkdirSync(path.join(homeDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, "skills"), { recursive: true });

  return config;
}

export function describeRuntime(cfg: Config): string {
  return [
    `model      : ${cfg.model}`,
    `endpoint   : ${cfg.baseUrl}`,
    `workspace  : ${cfg.workspace}`,
    `home       : ${cfg.homeDir}`,
    `platform   : ${process.platform} ${os.release()}`,
    `approval   : ${cfg.autoApprove ? "auto (shell runs without asking)" : "interactive (asks before shell)"}`,
  ].join("\n");
}
