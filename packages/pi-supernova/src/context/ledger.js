import { isObject, isString } from "../shared/decode.js";

const MIN_RUN = 6;

const MIN_SUBSTANTIVE = 4;

const MAX_CANDIDATES = 8;

const DEFAULT_WINDOW = 0;

const MAX_STORED_LINES = 200_000;

const MAX_OBSERVE_DEPTH = 64;

// A line this long is a minified blob or an inlined image, not a run of source. It
// cannot be part of a collapsible run anyway (MIN_RUN needs six lines), and skipping
// it keeps base64 payloads out of the retention set entirely.
const MAX_OBSERVED_LINE = 4096;

// A collapse marker is a citation, not content. Never index or re-collapse one, so
// citations cannot nest into a chain that points somewhere the reader must follow.
const COLLAPSE_MARKER = /^⋯ \d+ lines same as #\d+/;

function hashLine(line) {
  let hash = 0x811c9dc5;

  for (let i = 0; i < line.length; i++) hash = Math.imul(hash ^ line.charCodeAt(i), 0x01000193);

  return hash >>> 0;
}

function substantive(line) { return line.trim().length >= 8; }

function newHistory() {
  return { results: new Map(), occurrences: new Map(), storedLines: 0, latestCall: 0, retained: null,
    stats: { programs: 0, returnedChars: 0, collapsedChars: 0, collapsedRuns: 0 } };
}

// Experimental candidate collection, not proof of provider-visible retention:
// AgentMessage metadata and later context transformations can hide these strings.
// Keep this optimization opt-in until exact outgoing citation targets are validated.
function collectRetained(value, retained, depth = 0) {
  if (isString(value)) {
    // Every line, not only substantive ones. A run may span a blank or short line,
    // so isRetained must be exact per line or the run truncates there. An oversized
    // line is never stored: it cannot sit inside a six-line run, and this is what
    // keeps base64 image payloads out of the retention set.
    if (value.length > MAX_OBSERVED_LINE && !value.includes("\n")) return;

    for (const line of value.split("\n")) {
      if (retained.size >= MAX_STORED_LINES) return;

      if (line.length <= MAX_OBSERVED_LINE) retained.add(line);
    }

    return;
  }

  if (depth >= MAX_OBSERVE_DEPTH) return;

  if (Array.isArray(value)) {
    for (const item of value) collectRetained(item, retained, depth + 1);

    return;
  }

  // pi's AgentMessage payload is plain objects and arrays, so isObject is the whole
  // traversal contract; anything else is not message text.
  if (!isObject(value)) return;

  for (const key of Object.keys(value)) collectRetained(value[key], retained, depth + 1);
}

/** Content that may be collapsed out of a later result. Citations are excluded. */
function collapsible(line) { return substantive(line) && !COLLAPSE_MARKER.test(line); }

export class SeenLedger {
  constructor({ window = DEFAULT_WINDOW, history } = {}) {
    this.window = window;
    this.history = history ?? newHistory();
    this.origins = new Map();
    this.pinned = new Set();
  }
  get results() { return this.history.results; }
  get occurrences() { return this.history.occurrences; }
  get storedLines() { return this.history.storedLines; }
  get stats() { return this.history.stats; }
  get retainedLines() { return this.history.retained; }

  /**
   * Record candidate lines from the host's pre-request hook. This observation
   * includes metadata and precedes later transformations, so it is not proof
   * that a citation target will be present in the final provider payload.
   * Until this runs, nothing is collapsible, so the first result of a session is
   * always sent in full.
   */
  observe(payload) {
    if (this.window === 0) { this.history.retained = null;

 return; }

    const retained = new Set();
    collectRetained(payload, retained);
    this.history.retained = retained;
  }

  /** Candidate membership only; not a final-payload retention guarantee. */
  isRetained(line) {
    const retained = this.history.retained;

    return retained !== null && retained.has(line);
  }
  fork() { return new SeenLedger({ window: this.window, history: this.history }); }

  reset() {
    Object.assign(this.history, newHistory());
    this.origins.clear();
    this.pinned.clear();
  }

  beginProgram(call) {
    this.origins.clear();
    this.pinned.clear();
    this.stats.programs++;
    this.history.latestCall = Math.max(this.history.latestCall, call);

    for (const old of this.results.keys()) if (old <= this.history.latestCall - this.window) this.forget(old);
  }

  forget(call) {
    const entry = this.results.get(call);

    if (!entry) return;

    for (const hash of new Set(entry.hashes)) {
      const kept = (this.occurrences.get(hash) ?? []).filter(item => item.call !== call);

      if (kept.length) this.occurrences.set(hash, kept);
      else this.occurrences.delete(hash);
    }

    this.history.storedLines -= entry.lines.length;
    this.results.delete(call);
  }

  recordOrigin(path, firstLine, lines, pin = false) {
    if (this.window === 0) return;

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];

      if (!substantive(text)) continue;

      if (this.origins.size >= MAX_STORED_LINES && !this.origins.has(text)) this.origins.delete(this.origins.keys().next().value);
      this.origins.set(text, { path, line: firstLine + i });

      if (pin) this.pinned.add(text);
    }
  }

  runLength(lines, hashes, candidate, index) {
    const earlier = this.results.get(candidate.call);

    if (!earlier) return 0;
    let count = 0;

    while (index + count < lines.length && candidate.index + count < earlier.lines.length
      && hashes[index + count] === earlier.hashes[candidate.index + count]
      && lines[index + count] === earlier.lines[candidate.index + count]
      && !this.pinned.has(lines[index + count])
      // Experimental line membership does not establish a visible, ordered target.
      && this.isRetained(lines[index + count])) count++;

    return count;
  }

  longestRun(lines, hashes, index, call) {
    const candidates = this.occurrences.get(hashes[index]);

    if (!candidates) return null;
    let best = null;

    for (const candidate of candidates.filter(item => item.call < call).slice(-MAX_CANDIDATES)) {
      const length = this.runLength(lines, hashes, candidate, index);

      if (length >= MIN_RUN && (!best || length > best.length)) best = { ...candidate, length };
    }

    if (!best) return null;
    let count = 0;

    for (let i = index; i < index + best.length; i++) if (collapsible(lines[i])) count++;

    return count >= MIN_SUBSTANTIVE ? best : null;
  }

  citation(lines, index, run) {
    const earlier = this.results.get(run.call);
    const origin = offset => this.origins.get(lines[index + offset]) ?? earlier?.origins[run.index + offset];
    const first = origin(0);

    if (!first) return "";
    let expected = first.line;

    for (let i = 0; i < run.length; i++) {
      const item = origin(i);

      if (item && (item.path !== first.path || item.line !== expected)) return "";
      expected++;
    }

    return first.path + ":" + first.line + "–" + (expected - 1);
  }

  dedupe(text, call) {
    if (this.window === 0) {
      this.stats.returnedChars += text.length;

      return text;
    }

    const lines = text.split("\n");
    const hashes = Uint32Array.from(lines, hashLine);
    const out = [];
    let collapsedChars = 0;

    for (let i = 0; i < lines.length;) {
      const run = collapsible(lines[i]) ? this.longestRun(lines, hashes, i, call) : null;

      if (!run) { out.push(lines[i++]); continue; }

      const cite = this.citation(lines, i, run);
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
    if (this.window === 0 || call <= this.history.latestCall - this.window || lines.length > MAX_STORED_LINES) return;

    if (this.results.has(call)) this.forget(call);

    for (const old of [...this.results.keys()].sort((a, b) => a - b)) {
      if (this.storedLines + lines.length <= MAX_STORED_LINES) break;
      this.forget(old);
    }

    const hashes = Uint32Array.from(lines, hashLine);
    const origins = lines.map(line => this.origins.get(line));

    for (let i = 0; i < lines.length; i++) {
      if (!collapsible(lines[i])) continue;
      let list = this.occurrences.get(hashes[i]);

      if (!list) this.occurrences.set(hashes[i], (list = []));
      list.push({ call, index: i });
    }

    this.results.set(call, { hashes, lines, origins });
    this.history.storedLines += lines.length;
  }
}
