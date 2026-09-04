// Seen-ledger: the model's context window is a memory. Nothing that already reached the
// model in this session is sent again verbatim. A run of identical lines (≥ MIN_RUN, with
// enough substantive lines) collapses to one marker that cites the earlier program and,
// when the lines came from a file, path:a–b — so one read(path, a, n) recovers them.
//
// This is not compression: every collapsed line already exists, verbatim, in the model's
// context. Changed lines are never collapsed, so a re-read after an edit shows exactly the
// delta. Lines the current program read with an explicit offset/limit are pinned and always
// shown — that is the model asking for a specific window on purpose.

const MIN_RUN = 6;
const MIN_SUBSTANTIVE = 4;
const MAX_CANDIDATES = 8;
const DEFAULT_WINDOW = 40;
const MAX_STORED_LINES = 200_000;

export function hashLine(line) {
  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function substantive(line) {
  return line.trim().length >= 8;
}

export class SeenLedger {
  constructor({ window = DEFAULT_WINDOW } = {}) {
    this.window = window;
    this.results = new Map(); // call → { hashes: Uint32Array, lines: string[] }
    this.occurrences = new Map(); // hash → [{ call, index }]
    this.origins = new Map(); // hash → { path, line }  (provenance recorded by the bridge)
    this.pinned = new Set(); // "path:line" pinned by the current program
    this.storedLines = 0;
    this.stats = { programs: 0, returnedChars: 0, collapsedChars: 0, collapsedRuns: 0 };
  }

  reset() {
    this.results.clear();
    this.occurrences.clear();
    this.origins.clear();
    this.pinned.clear();
    this.storedLines = 0;
    this.stats = { programs: 0, returnedChars: 0, collapsedChars: 0, collapsedRuns: 0 };
  }

  beginProgram(call) {
    this.pinned.clear();
    this.stats.programs++;
    for (const old of [...this.results.keys()]) {
      if (old <= call - this.window) this.forget(old);
    }
  }

  forget(call) {
    const entry = this.results.get(call);
    if (!entry) return;
    for (let i = 0; i < entry.hashes.length; i++) {
      const list = this.occurrences.get(entry.hashes[i]);
      if (!list) continue;
      const kept = list.filter((o) => o.call !== call);
      if (kept.length) this.occurrences.set(entry.hashes[i], kept);
      else this.occurrences.delete(entry.hashes[i]);
    }
    this.storedLines -= entry.hashes.length;
    this.results.delete(call);
  }

  /** Provenance for lines the bridge is about to hand to the program: file text, outlines, evidence spans. */
  recordOrigin(path, firstLine, lines, pin = false) {
    for (let i = 0; i < lines.length; i++) {
      if (!substantive(lines[i])) continue;
      this.origins.set(hashLine(lines[i]), { path, line: firstLine + i });
      if (pin) this.pinned.add(path + ":" + (firstLine + i));
    }
  }

  isPinned(hash) {
    const o = this.origins.get(hash);
    return o !== undefined && this.pinned.has(o.path + ":" + o.line);
  }

  /** Length of the identical run between lines[i…] and earlier result `cand`, stopping at pinned lines. */
  runLength(hashes, cand, i) {
    const earlier = this.results.get(cand.call);
    if (!earlier) return 0;
    let k = 0;
    while (i + k < hashes.length && cand.index + k < earlier.hashes.length && earlier.hashes[cand.index + k] === hashes[i + k] && !this.isPinned(hashes[i + k])) k++;
    return k;
  }

  /** Longest earlier run starting at lines[i]; null when shorter than MIN_RUN or not substantive enough. */
  longestRun(hashes, lines, i) {
    const candidates = this.occurrences.get(hashes[i]);
    if (!candidates) return null;
    let best = null;
    for (const cand of candidates.slice(-MAX_CANDIDATES)) {
      const length = this.runLength(hashes, cand, i);
      if (length >= MIN_RUN && (!best || length > best.length)) best = { call: cand.call, index: cand.index, length };
    }
    if (!best) return null;
    const substantiveCount = lines.slice(i, i + best.length).filter(substantive).length;
    return substantiveCount >= MIN_SUBSTANTIVE ? best : null;
  }

  /** "path:a–b" when every line of the run has consecutive provenance in one file, else "". */
  citation(hashes, i, length) {
    const first = this.origins.get(hashes[i]);
    if (!first) return "";
    let expectLine = first.line;
    for (let k = 0; k < length; k++) {
      const o = this.origins.get(hashes[i + k]);
      if (o) {
        if (o.path !== first.path || o.line < expectLine) return "";
        expectLine = o.line + 1;
      } else {
        expectLine++;
      }
    }
    return first.path + ":" + first.line + "–" + (expectLine - 1);
  }

  /**
   * Collapse runs already shown; returns the text to send and remembers exactly that text as call N.
   */
  dedupe(text, call) {
    const lines = text.split("\n");
    const hashes = new Uint32Array(lines.length);
    for (let i = 0; i < lines.length; i++) hashes[i] = hashLine(lines[i]);
    const out = [];
    let collapsedChars = 0;
    for (let i = 0; i < lines.length; ) {
      const run = substantive(lines[i]) ? this.longestRun(hashes, lines, i) : null;
      if (!run) {
        out.push(lines[i]);
        i++;
        continue;
      }
      const cite = this.citation(hashes, i, run.length);
      out.push("⋯ " + run.length + " lines same as #" + run.call + (cite ? " · " + cite : "") + " ⋯");
      for (let k = 0; k < run.length; k++) collapsedChars += lines[i + k].length + 1;
      this.stats.collapsedRuns++;
      i += run.length;
    }
    const sent = out.join("\n");
    this.stats.returnedChars += sent.length;
    this.stats.collapsedChars += collapsedChars;
    this.remember(call, out);
    return sent;
  }

  remember(call, lines) {
    if (this.storedLines + lines.length > MAX_STORED_LINES) {
      for (const old of [...this.results.keys()].sort((a, b) => a - b)) {
        this.forget(old);
        if (this.storedLines + lines.length <= MAX_STORED_LINES) break;
      }
    }
    const hashes = new Uint32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      hashes[i] = hashLine(lines[i]);
      if (!substantive(lines[i])) continue;
      let list = this.occurrences.get(hashes[i]);
      if (!list) this.occurrences.set(hashes[i], (list = []));
      list.push({ call, index: i });
    }
    this.results.set(call, { hashes });
    this.storedLines += lines.length;
  }
}
