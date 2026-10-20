/**
 * Markdown → HTML for chat bubbles.
 * Pure functions, no DOM access, so they can be unit-tested in Node.
 */

export function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

/**
 * Deliberately small: code fences, inline code, bold, links, headings, lists.
 * Everything is escaped before any tag is introduced, so model output can
 * never inject HTML.
 */
export function mdToHtml(src) {
  const blocks = [];
  let text = String(src ?? "").replace(/```([\w-]*)\r?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const i = blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`) - 1;
    return `\u0000B${i}\u0000`;
  });

  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );

  text = text
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>");

  text = text.replace(/(?:^[-*] .*(?:\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((line) => `<li>${line.replace(/^[-*] /, "")}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  });

  const html = text
    .split(/\n{2,}/)
    .map((chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return "";
      if (/^<(h[1-6]|ul|ol|pre|li|blockquote)/.test(trimmed)) return trimmed;
      if (/^\u0000B\d+\u0000$/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  return html.replace(/\u0000B(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? "");
}
