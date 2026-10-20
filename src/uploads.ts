import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export type FileKind = "image" | "text" | "binary";

export interface UploadRecord {
  /** Stable id, also the file name on disk. */
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: FileKind;
  abs: string;
}

const TEXT_EXT =
  /\.(txt|md|markdown|mdx|json|jsonc|jsonl|csv|tsv|ya?ml|toml|ini|cfg|conf|log|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|ps1|bat|sql|html?|css|scss|sass|less|xml|svg|env|gitignore|dockerfile)$/i;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i;

export function uploadsDir(stateDir: string): string {
  return path.join(stateDir, "uploads");
}

export function classifyFile(name: string, mime: string): FileKind {
  if (/^image\//i.test(mime) && !/svg/i.test(mime)) return "image";
  if (IMAGE_EXT.test(name)) return "image";
  if (/^text\//i.test(mime)) return "text";
  if (/json|xml|javascript|typescript|yaml|x-sh|sql|csv/i.test(mime)) return "text";
  if (IMAGE_EXT.test(mime)) return "image";
  if (TEXT_EXT.test(name)) return "text";
  return "binary";
}

/** Keep the name human-readable but harmless on disk. */
export function safeFileName(name: string): string {
  const base = path.basename(String(name ?? "").replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return cleaned || "file";
}

export function saveUpload(
  stateDir: string,
  originalName: string,
  mime: string,
  data: Buffer,
): UploadRecord {
  if (!data.length) throw new Error("空文件");
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new Error(`文件过大（${(data.length / 1024 / 1024).toFixed(1)} MB，上限 10 MB）`);
  }

  const dir = uploadsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });

  const name = safeFileName(originalName);
  const id = `${randomUUID().slice(0, 8)}-${name}`;
  const abs = path.join(dir, id);
  fs.writeFileSync(abs, data);

  return { id, name, size: data.length, mime: mime || "application/octet-stream", kind: classifyFile(name, mime), abs };
}

/** Resolve an attachment id back to a file, refusing anything outside uploads/. */
export function resolveUpload(stateDir: string, id: string): UploadRecord | undefined {
  const clean = path.basename(String(id ?? ""));
  if (!clean || clean !== id) return undefined;
  const abs = path.join(uploadsDir(stateDir), clean);
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return undefined;
    const name = clean.replace(/^[0-9a-f-]{8,9}-/, "");
    const mime = guessMime(name);
    return { id: clean, name, size: stat.size, mime, kind: classifyFile(name, mime), abs };
  } catch {
    return undefined;
  }
}

export function deleteUpload(stateDir: string, id: string): boolean {
  const rec = resolveUpload(stateDir, id);
  if (!rec) return false;
  try {
    fs.rmSync(rec.abs, { force: true });
    return true;
  } catch {
    return false;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/plain",
  py: "text/x-python",
  zip: "application/zip",
};

export function guessMime(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/* ------------------------------------------------------------------ */
/* multipart/form-data (no dependencies)                              */
/* ------------------------------------------------------------------ */

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType: string;
  data: Buffer;
}

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  const headerBreak = Buffer.from("\r\n\r\n");
  const crlf = Buffer.from("\r\n");

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return parts;
  cursor += delimiter.length;

  for (;;) {
    if (body.slice(cursor, cursor + 2).toString() === "--") break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;

    const headerEnd = body.indexOf(headerBreak, cursor);
    if (headerEnd === -1) break;

    const headers = parseHeaders(body.slice(cursor, headerEnd).toString("utf8"));
    const dataStart = headerEnd + headerBreak.length;
    const nextBoundary = body.indexOf(delimiter, dataStart);
    if (nextBoundary === -1) break;

    const dataEnd = Math.max(dataStart, nextBoundary - crlf.length);
    const disposition = headers["content-disposition"] ?? "";
    const nameMatch = /(?:^|;)\s*name="([^"]*)"/.exec(disposition);

    parts.push({
      name: nameMatch?.[1] ?? "",
      filename: /filename="([^"]*)"/.exec(disposition)?.[1],
      contentType: headers["content-type"] ?? "application/octet-stream",
      data: body.slice(dataStart, dataEnd),
    });

    cursor = nextBoundary + delimiter.length;
  }

  return parts;
}

export function boundaryOf(contentType: string): string | undefined {
  return /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean);
}
