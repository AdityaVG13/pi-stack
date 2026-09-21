import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {tokenizeQuery,stem} from '../context/snap.js';
import {runCommand} from '../fs/workspace.js';
import {lineStartIndex,lineTextRange} from '../fs/lines.js';
import {textResult} from '../shared/result.js';
export function createFocusedReader(vfs, readBudget) {
  function aboutStems(about, requireStem) {
    const tokens = tokenizeQuery(about).tokens;

    if (tokens.length > 16) throw new Error("about is too broad; use at most 16 keywords");
    const stems = [...new Set(tokens.map(token => stem(token).slice(0, 128)))];

    if (requireStem && !stems.length) throw new Error("about needs at least one searchable keyword");

    return stems;
  }

  function overlayHits(overlay, stems, signal) {
    const hits = [];
    let line = 1;
    let start = 0;

    while (start <= overlay.length) {
      signal?.throwIfAborted();
      const newline = overlay.indexOf("\n", start);
      const end = newline < 0 ? overlay.length : newline + 1;
      const row = overlay.slice(start, newline < 0 ? end : newline).replace(/\r$/, "").toLowerCase();

      if (stems.some(st => row.includes(st))) {
        hits.push(line);
        if (hits.length >= 200) break;
      }

      if (end === overlay.length) break;
      start = end;
      line++;
    }

    return { hits, lineCount: line };
  }

  function overlayWindows(rel, overlay, hits, lineCount, budget) {
    const out = [];
    let cursor = 1;
    let used = 0;
    let truncated = hits.length >= 200;

    for (const hit of hits) {
      const from = Math.max(cursor, hit - 3);
      const first = lineStartIndex(overlay, from);
      const last = lineTextRange(overlay, Math.min(hit + 3, lineCount)).end;
      const body = overlay.slice(first, last);

      if (used + body.length > budget) { truncated = true; break; }
      if (out.length && from > cursor) out.push("...");
      out.push(`// ${rel}:${from}\n${body}`);
      used += body.length;
      cursor = Math.max(cursor, hit + 4);
    }

    return { out, truncated };
  }

  async function focusDisk(rel, about, targetPath, stems, budget, signal) {
    const args = ["rg", "--fixed-strings", "--ignore-case", "--line-number", "--before-context", "3", "--after-context", "3"];

    for (const token of stems) args.push("-e", token);
    args.push("--", targetPath);
    const observed = await fs.stat(targetPath);
    const res = await runCommand(args, { cwd: path.dirname(targetPath), timeoutMs: 15000, maxOutputChars: budget, signal });

    if (res.exitCode === 0 || res.exitCode === 1) await vfs.recordExpected(targetPath, observed);
    if (res.exitCode === 1) return textResult("// " + rel + " · no matching text\n", { path: targetPath, outputTruncated: false, complete: false });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `rg exited ${res.exitCode}`);
    const marker = res.outputTruncated ? "\n[focused read truncated; narrow about or use read(path, line, count)]" : "";

    return textResult("// " + rel + " · focused text windows (not a complete file); read(path, line, count) for raw text\n" + res.stdout + marker,
      { path: targetPath, outputTruncated: res.outputTruncated, complete: false });
  }

  async function focusAbout({ rel, about, overlay, targetPath, signal }) {
    const stems = aboutStems(about, overlay === undefined);
    const budget = readBudget(false);

    if (overlay === undefined) return focusDisk(rel, about, targetPath, stems, budget, signal);
    const { hits, lineCount } = overlayHits(overlay, stems, signal);
    const { out, truncated } = overlayWindows(rel, overlay, hits, lineCount, budget);

    if (!out.length) return textResult("// " + rel + (hits.length
      ? " · matching text exceeds view budget; first match at line " + hits[0] + "; use read(path, line, count)\n"
      : " · no matching staged text\n"), { path: targetPath, outputTruncated: truncated, complete: false });
    const marker = truncated ? "\n[focused read truncated; narrow about or use read(path, line, count)]" : "";

    return textResult("// " + rel + " · focused staged text windows (not a complete file)\n" + out.join("\n") + marker, { path: targetPath, outputTruncated: truncated, complete: false });
  }
  return focusAbout;
}
