import type { Config } from "./config.js";
import type { ChatMessage, ToolCall, ToolSpec } from "./types.js";

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export function wireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls?.length) base.tool_calls = m.tool_calls;
    if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
    if (m.name) base.name = m.name;
    return base;
  });
}

export function wireTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Network-level failures worth another attempt (undici often reports "fetch failed"). */
function isRetryableNetwork(err: unknown): boolean {
  const e = err as { message?: string; cause?: { code?: string } };
  const code = e?.cause?.code ?? "";
  if (/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) {
    return true;
  }
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|other side closed|network/i.test(
    e?.message ?? "",
  );
}

/** Turn a raw fetch failure into something a human can act on. */
export function describeLlmError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const code = e?.cause?.code;
  const message = e?.message ?? String(err);
  if (message === "fetch failed" || message === "terminated") {
    return code
      ? `无法连接到模型服务（${code}），检查网络、代理或 baseUrl`
      : "无法连接到模型服务（连接被重置或中断），检查网络或代理设置";
  }
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/** A chunk emitted by the streaming client. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; finishReason?: string; toolCalls: ToolCall[] };

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of raw.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload) yield payload;
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** POST with retries for connection-level failures and retryable HTTP codes. */
async function postStream(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, init);
      if (RETRYABLE.has(res.status) && attempt < 2) {
        const text = await res.text().catch(() => "");
        lastError = new LLMError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
        await sleep(700 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      const aborted = (err as Error).name === "AbortError" || signal?.aborted;
      if (aborted || !isRetryableNetwork(err) || attempt >= 2) throw err;
      await sleep(700 * 2 ** attempt);
    }
  }

  throw lastError;
}

/** Streaming variant of chatCompletion, for SSE endpoints. */
export async function* chatCompletionStream(
  cfg: Config,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; toolChoice?: "auto" | "none"; tools?: ToolSpec[] } = {},
): AsyncGenerator<StreamEvent> {
  if (!cfg.apiKey) {
    throw new LLMError(
      "No API key for this model. Set it in the environment or .env (see models.json apiKeyEnv).",
    );
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: wireMessages(messages),
    temperature: cfg.temperature,
    stream: true,
  };
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
  if (opts.tools?.length) {
    body.tools = wireTools(opts.tools);
    body.tool_choice = opts.toolChoice ?? "auto";
  }

  let res: Response;
  try {
    res = await postStream(
      endpoint(cfg.baseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      },
      opts.signal,
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new LLMError(describeLlmError(err));
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new LLMError(
      `LLM request failed (HTTP ${res.status}): ${text.slice(0, 800) || res.statusText}`,
      res.status,
    );
  }

  const calls = new Map<number, ToolCall>();
  let finishReason: string | undefined;

  for await (const payload of parseSSE(res.body, opts.signal)) {
    if (payload === "[DONE]") break;
    let json: {
      choices?: {
        delta?: {
          content?: string | null;
          tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: string | null;
      }[];
    };
    try {
      json = JSON.parse(payload);
    } catch {
      continue; // keep-alive comment or vendor-specific frame
    }
    const choice = json.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) yield { type: "text", text: delta.content };

    for (const tc of delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const existing = calls.get(idx) ?? {
        id: tc.id ?? `call_${idx}`,
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.function.name += tc.function.name;
      if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      calls.set(idx, existing);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }

  yield { type: "done", finishReason, toolCalls: [...calls.values()].filter((c) => c.function.name) };
}


async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** One non-streaming call to an OpenAI-compatible /chat/completions endpoint. */
export async function chatCompletion(
  cfg: Config,
  messages: ChatMessage[],
  tools: ToolSpec[],
  opts: { signal?: AbortSignal; toolChoice?: "auto" | "none" } = {},
): Promise<CompletionResult> {
  if (!cfg.apiKey) {
    throw new LLMError(
      "No API key. Set TSA_API_KEY in the environment or in .env next to the project.",
    );
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: wireMessages(messages),
    temperature: cfg.temperature,
    stream: false,
  };
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
  if (tools.length) {
    body.tools = wireTools(tools);
    body.tool_choice = opts.toolChoice ?? "auto";
  }

  const payload = JSON.stringify(body);
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(endpoint(cfg.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: payload,
        signal: opts.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (RETRYABLE.has(res.status) && attempt < 2) {
          lastError = new LLMError(`HTTP ${res.status}: ${text.slice(0, 400)}`, res.status);
          await sleep(600 * 2 ** attempt);
          continue;
        }
        throw new LLMError(
          `LLM request failed (HTTP ${res.status}): ${text.slice(0, 800) || res.statusText}`,
          res.status,
        );
      }

      const json = (await res.json()) as {
        choices?: {
          message?: { content?: string | null; tool_calls?: ToolCall[] };
          finish_reason?: string;
        }[];
        usage?: CompletionResult["usage"];
      };

      const choice = json.choices?.[0];
      if (!choice?.message) throw new LLMError("Malformed response: missing choices[0].message");

      return {
        content: choice.message.content ?? null,
        toolCalls: choice.message.tool_calls ?? [],
        finishReason: choice.finish_reason,
        usage: json.usage,
      };
    } catch (err) {
      lastError = err;
      const retryableNetwork =
        err instanceof Error &&
        !(err instanceof LLMError) &&
        /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(err.message);
      if (retryableNetwork && attempt < 2) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }

  if (lastError instanceof LLMError) throw lastError;
  throw new LLMError(describeLlmError(lastError));
}
