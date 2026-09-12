import { truncateChars } from "../output/format.js";

export function pickSpan(spans, { line, name } = {}) {
  const needle = typeof name === "string" && /^[A-Za-z_$][\w$]*$/.test(name.trim()) ? name.trim().toLowerCase() : "";
  const named = needle ? spans.filter(item => item.name.toLowerCase() === needle) : [];

  if (named.length === 1) return named[0];
  if (!line) return;

  return spans.find(item => item.start === line)
    ?? spans.filter(item => item.start <= line && line <= item.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}

export function spanWindow(text, start, end) {
  const raw = text.split("\n");

  return {
    start,
    end,
    text: raw.slice(start - 1, end).join("\n"),
    signature: truncateChars((raw[start - 1] ?? "").trim().replace(/\{.*$/, "").trim(), 240, "signature").text,
    context: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => {
      const n = start + i;

      return { line: n, text: raw[n - 1] ?? "" };
    }),
  };
}

export function spanCandidate(relPath, line, window) {
  return {
    path: relPath,
    line,
    lines: [window.start, window.end],
    text: window.text,
    signature: window.signature,
    context: window.context.map(row => (row.line === line ? "►" : " ") + row.line + " " + row.text),
  };
}
