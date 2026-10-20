import fs from "node:fs";
import path from "node:path";
import { parseDotEnv } from "./config.js";

/** One selectable chat model. `apiKey` is never sent to the browser. */
export interface ModelEntry {
  id: string;
  label: string;
  provider?: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Name of the environment variable holding the key. */
  apiKeyEnv?: string;
  temperature?: number;
  /** false for local runtimes (Ollama, vLLM) that need no key. */
  requiresKey?: boolean;
  /** Stored only in models.local.json: user removed this model. */
  hidden?: boolean;
}

/** What the frontend is allowed to see. */
export interface PublicModel {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string;
  available: boolean;
  hasKey: boolean;
  editable: boolean;
  requiresKey: boolean;
  reason?: string;
}

export const DEFAULT_MODELS: ModelEntry[] = [
  {
    id: "qwen-plus",
    label: "Qwen Plus",
    provider: "DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  {
    id: "qwen-max",
    label: "Qwen Max",
    provider: "DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-max",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  {
    id: "deepseek-chat",
    label: "DeepSeek Chat",
    provider: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "qwen-local",
    label: "Qwen 2.5 (Ollama)",
    provider: "Local",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:7b",
    requiresKey: false,
  },
];

/** process.env wins over .env, same precedence as the CLI. */
export function loadEnv(root: string): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  try {
    Object.assign(merged, parseDotEnv(fs.readFileSync(path.join(root, ".env"), "utf8")));
  } catch {
    /* no .env */
  }
  return { ...merged, ...process.env };
}

export function resolveApiKey(entry: ModelEntry, env: Record<string, string | undefined>): string {
  if (entry.hidden) return "";
  if (entry.apiKey?.trim()) return entry.apiKey.trim();
  if (entry.apiKeyEnv && env[entry.apiKeyEnv]?.trim()) return env[entry.apiKeyEnv]!.trim();
  // Fall back to the key configured for the CLI, if the provider looks like the same vendor.
  const tsa = env.TSA_API_KEY?.trim();
  if (tsa && !/replace-me/i.test(tsa)) {
    const base = entry.baseUrl.toLowerCase();
    if (entry.apiKeyEnv === undefined && /ollama|localhost/.test(base)) return tsa;
    if (tsa.startsWith("sk-") && /openai\.com|deepseek/.test(base)) return tsa;
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* storage: models.json (read-only catalog) + models.local.json (edits) */
/* ------------------------------------------------------------------ */

export interface ModelCatalog {
  entries: (ModelEntry & { editable: boolean })[];
  source: "models.json" | "built-in";
  warnings: string[];
}

export function localModelsFile(root: string): string {
  const override = process.env.TSA_MODELS_LOCAL_FILE?.trim();
  return override ? path.resolve(override) : path.join(root, "models.local.json");
}

function modelFile(root: string): string {
  const override = process.env.TSA_MODELS_FILE?.trim();
  return override ? path.resolve(override) : path.join(root, "models.json");
}

function readModelsArray(file: string): { entries: ModelEntry[]; warning?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { entries: [] };
  }
  try {
    const parsed = JSON.parse(raw) as { models?: unknown } | unknown[];
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.models) ? parsed.models : null;
    if (!list) return { entries: [], warning: `${path.basename(file)} has no "models" array` };
    const entries: ModelEntry[] = [];
    for (const item of list) {
      const m = item as Partial<ModelEntry>;
      if (!m.id || !m.baseUrl || !m.model) continue;
      entries.push({
        id: String(m.id),
        label: String(m.label ?? m.id),
        provider: m.provider ? String(m.provider) : undefined,
        baseUrl: String(m.baseUrl),
        model: String(m.model),
        apiKey: m.apiKey,
        apiKeyEnv: m.apiKeyEnv,
        temperature: typeof m.temperature === "number" ? m.temperature : undefined,
        requiresKey: m.requiresKey,
        hidden: m.hidden === true,
      });
    }
    return { entries };
  } catch (err) {
    return { entries: [], warning: `${path.basename(file)} is invalid (${(err as Error).message})` };
  }
}

export function loadLocalModels(root: string): ModelEntry[] {
  return readModelsArray(localModelsFile(root)).entries;
}

/** Atomic-ish write: temp file then rename. */
export function saveLocalModels(root: string, entries: ModelEntry[]): void {
  const file = localModelsFile(root);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      {
        _comment: "由网页「模型管理」写入。里面是明文 API key，不要提交到仓库。",
        models: entries,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.renameSync(tmp, file);
}

export function upsertLocalModel(
  root: string,
  incoming: Partial<ModelEntry> & { id: string },
): ModelEntry {
  const existing = loadLocalModels(root);
  const index = existing.findIndex((m) => m.id === incoming.id);
  const previous = index >= 0 ? existing[index]! : undefined;

  // apiKey === undefined keeps the stored key; "" clears it.
  const apiKey =
    incoming.apiKey === undefined ? previous?.apiKey : incoming.apiKey.trim() || undefined;

  const next: ModelEntry = {
    id: incoming.id,
    label: incoming.label ?? previous?.label ?? incoming.id,
    provider: incoming.provider ?? previous?.provider,
    baseUrl: incoming.baseUrl ?? previous?.baseUrl ?? "",
    model: incoming.model ?? previous?.model ?? incoming.id,
    apiKey,
    apiKeyEnv: incoming.apiKeyEnv ?? previous?.apiKeyEnv,
    requiresKey: incoming.requiresKey ?? previous?.requiresKey,
    hidden: false,
  };

  if (index >= 0) existing[index] = next;
  else existing.push(next);
  saveLocalModels(root, existing);
  return next;
}

export function deleteLocalModel(root: string, id: string): boolean {
  const existing = loadLocalModels(root);
  const next = existing.filter((m) => m.id !== id);

  // Deleting a built-in model hides it instead of resurrecting the default.
  const builtin = new Map(DEFAULT_MODELS.map((m) => [m.id, m]));
  const fromFile = readModelsArray(modelFile(root)).entries;
  for (const m of fromFile) builtin.set(m.id, m);

  if (builtin.has(id) && next.length === existing.length) {
    next.push({ ...builtin.get(id)!, hidden: true });
  }

  if (next.length === existing.length && !builtin.has(id)) return false;
  saveLocalModels(root, next);
  return true;
}

export function loadModels(root: string): ModelCatalog {
  const warnings: string[] = [];
  const file = modelFile(root);

  let base: ModelEntry[];
  let source: ModelCatalog["source"];
  if (!fs.existsSync(file)) {
    base = DEFAULT_MODELS;
    source = "built-in";
  } else {
    const read = readModelsArray(file);
    base = read.entries.length ? read.entries : DEFAULT_MODELS;
    if (read.warning) warnings.push(read.warning);
    source = read.entries.length ? "models.json" : "built-in";
  }

  const localRead = readModelsArray(localModelsFile(root));
  if (localRead.warning) warnings.push(localRead.warning);
  const local = localRead.entries;
  const localIds = new Set(local.map((m) => m.id));

  const merged: (ModelEntry & { editable: boolean })[] = [];
  const seen = new Set<string>();

  for (const entry of base) {
    const override = local.find((m) => m.id === entry.id);
    if (override?.hidden) {
      seen.add(entry.id);
      continue;
    }
    const mergedEntry = override ? { ...entry, ...stripUndefined(override) } : entry;
    merged.push({ ...mergedEntry, editable: Boolean(override) });
    seen.add(entry.id);
  }

  for (const entry of local) {
    if (seen.has(entry.id) || entry.hidden) continue;
    merged.push({ ...entry, editable: true });
  }

  return { entries: merged, source, warnings };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj) as [keyof T, unknown][]) {
    if (v !== undefined) out[k] = v as T[keyof T];
  }
  return out;
}

export function toPublic(entry: ModelEntry, env: Record<string, string | undefined>): PublicModel {
  const needsKey = entry.requiresKey !== false;
  const key = resolveApiKey(entry, env);
  const hasKey = Boolean(key);
  return {
    id: entry.id,
    label: entry.label,
    provider: entry.provider ?? "custom",
    model: entry.model,
    baseUrl: entry.baseUrl,
    available: needsKey ? hasKey : true,
    hasKey,
    editable: (entry as { editable?: boolean }).editable === true,
    requiresKey: needsKey,
    reason: !needsKey ? undefined : hasKey ? undefined : `missing ${entry.apiKeyEnv ?? "API key"}`,
  };
}

export function findModel(
  entries: ModelEntry[],
  idOrModel: string,
): ModelEntry | undefined {
  return (
    entries.find((m) => m.id === idOrModel) ??
    entries.find((m) => m.model === idOrModel) ??
    entries.find((m) => m.id.toLowerCase() === idOrModel.toLowerCase())
  );
}

/** Validation for the write endpoint. Returns a normalized entry or throws. */
export function validateModelInput(body: Record<string, unknown>): Partial<ModelEntry> & { id: string } {
  const id = String(body.id ?? "").trim();
  if (!/^[a-zA-Z0-9._:-]{1,60}$/.test(id)) {
    throw new Error("id 只能包含字母、数字、点、下划线、冒号、短横线，长度 1-60");
  }

  const baseUrl = String(body.baseUrl ?? "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("baseUrl 必须以 http:// 或 https:// 开头");
  try {
    new URL(baseUrl);
  } catch {
    throw new Error("baseUrl 不是合法 URL");
  }

  const model = String(body.model ?? "").trim();
  if (!model || model.length > 120) throw new Error("model 不能为空且不超过 120 字符");

  const label = String(body.label ?? "").trim().slice(0, 80) || id;
  const provider = String(body.provider ?? "").trim().slice(0, 40) || undefined;
  const requiresKey = body.requiresKey === false ? false : true;

  const rawKey = body.apiKey;
  if (rawKey !== undefined && typeof rawKey !== "string") throw new Error("apiKey 必须是字符串");
  const apiKey = typeof rawKey === "string" ? rawKey.trim() : undefined;
  if (apiKey && apiKey.length > 500) throw new Error("apiKey 过长");

  return { id, label, provider, baseUrl, model, requiresKey, apiKey };
}
