import type { Tool } from "../types.js";
import { numArg, str, ToolError } from "./common.js";

const MAX_BYTES = 500_000;

function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  const entities: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&mdash;": "—",
    "&ndash;": "–",
  };
  for (const [k, v] of Object.entries(entities)) text = text.split(k).join(v);
  text = text.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, arr) => l || (arr[i - 1] ?? "") !== "")
    .join("\n")
    .trim();
}

export const webFetchTool: Tool = {
  spec: {
    name: "web_fetch",
    description: "Fetch a URL and return readable text (HTML is stripped). Use for docs, issues, articles.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        max_chars: { type: "number", description: "Truncate output to this many chars (default 12000)." },
      },
      required: ["url"],
    },
  },
  async run(args) {
    const rawUrl = str(args, "url");
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ToolError(`Invalid URL: ${rawUrl}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ToolError("Only http(s) URLs are supported");
    }
    const maxChars = Math.min(60_000, Math.max(500, numArg(args, "max_chars") ?? 12_000));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": "ts-agent/0.1 (+https://github.com/)",
          accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        },
      });
      const contentType = res.headers.get("content-type") ?? "";
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) {
        throw new ToolError(`Response too large (${buf.byteLength} bytes)`);
      }
      const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const text = /html|xml/i.test(contentType) ? htmlToText(body) : body.trim();
      const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n...(truncated)` : text;
      return {
        content: `HTTP ${res.status} ${contentType}\nURL: ${res.url}\n---\n${clipped || "(empty body)"}`,
        isError: !res.ok,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
