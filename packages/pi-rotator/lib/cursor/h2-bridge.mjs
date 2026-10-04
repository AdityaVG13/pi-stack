#!/usr/bin/env node
/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */
/**
 * Dumb HTTP/2 bidirectional pipe for Cursor gRPC.
 *
 * Originally from https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan (MIT).
 *
 * Bun's node:http2 is broken. This Node script acts as a transparent
 * HTTP/2 proxy: it opens a single bidirectional stream and ferries
 * raw bytes between the parent process (via stdin/stdout) and Cursor.
 *
 * Protocol (length-prefixed framing over stdin/stdout):
 *   [4 bytes big-endian length][payload]
 *
 * First message on stdin is JSON config:
 *   { "accessToken": "...", "url": "...", "path": "...", "unary": false }
 *
 * When unary=true, the bridge uses application/proto (raw protobuf) instead
 * of application/connect+proto (Connect streaming). The single stdin message
 * is written as the request body and the stream is ended immediately.
 * After config, subsequent stdin messages are raw bytes to write to the H2 stream.
 * H2 response data is written to stdout using the same length-prefixed framing.
 */
import http2 from "node:http2";
import crypto from "node:crypto";

const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

/** Write one length-prefixed message to stdout. */
function writeMessage(data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(data);
}

// --- Buffered stdin reader ---

let stdinBuf = Buffer.alloc(0);
let stdinResolve = null;
let stdinEnded = false;

process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (stdinResolve) {
    const r = stdinResolve;
    stdinResolve = null;
    r();
  }
});

function waitForData() {
  return new Promise((resolve) => { stdinResolve = resolve; });
}

async function readExact(n) {
  while (stdinBuf.length < n) {
    if (stdinEnded) return null;
    await waitForData();
  }
  const result = stdinBuf.subarray(0, n);
  stdinBuf = stdinBuf.subarray(n);
  return Buffer.from(result);
}

async function readMessage() {
  const lenBuf = await readExact(4);
  if (!lenBuf) return null;
  const len = lenBuf.readUInt32BE(0);
  if (len === 0) return Buffer.alloc(0);
  return readExact(len);
}

// --- Main ---

const configBuf = await readMessage();
if (!configBuf) process.exit(1);

const config = JSON.parse(configBuf.toString("utf8"));
const { accessToken, url, path: rpcPath, unary } = config;

const client = http2.connect(url || "https://api2.cursor.sh");

// Guard against initial connection failure. Reset on any h2 activity
// so long-running agent conversations (with tool call round-trips) survive.
let timeout = setTimeout(killBridge, 30_000);

function resetTimeout() {
  clearTimeout(timeout);
  timeout = setTimeout(killBridge, 120_000);
}

function killBridge() {
  clearTimeout(timeout);
  client.destroy();
  process.exit(1);
}

client.on("error", () => {
  clearTimeout(timeout);
  process.exit(1);
});

const headers = {
  ":method": "POST",
  ":path": rpcPath || "/agent.v1.AgentService/Run",
  "content-type": unary ? "application/proto" : "application/connect+proto",
  "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",
  te: "trailers",
  authorization: `Bearer ${accessToken}`,
  "x-ghost-mode": "true",
  "x-cursor-client-version": CURSOR_CLIENT_VERSION,
  "x-cursor-client-type": "cli",
  "x-request-id": crypto.randomUUID(),
};
if (!unary) {
  headers["connect-protocol-version"] = "1";
}
const h2Stream = client.request(headers);

// HTTP errors are not Connect frames (and may contain private proxy/auth HTML).
// Preserve status, not body, so callers can distinguish account rejection from EOF.
let responseOk = false;
h2Stream.on("response", (responseHeaders) => {
  const status = Number(responseHeaders[":status"]);
  responseOk = status >= 200 && status < 300;
  if (responseOk || unary) return;
  const error = Buffer.from(JSON.stringify({ error: { code: "http_error", message: `Cursor upstream HTTP ${status}` } }));
  const frame = Buffer.alloc(5 + error.length);
  frame[0] = 2;
  frame.writeUInt32BE(error.length, 1);
  frame.set(error, 5);
  writeMessage(frame);
});

// Forward successful H2 response data → stdout (length-prefixed).
h2Stream.on("data", (chunk) => {
  resetTimeout();
  if (responseOk) writeMessage(chunk);
});

h2Stream.on("end", () => {
  clearTimeout(timeout);
  client.close();
  // A fixed grace can truncate a backed-up pipe; success follows the final stdout flush.
  process.stdout.end(() => process.exit(responseOk ? 0 : 1));
});

h2Stream.on("error", () => {
  clearTimeout(timeout);
  client.close();
  process.exit(1);
});

// Forward stdin → H2 stream (after config message)
if (unary) {
  // Unary mode: read a single body message, write it, and end the stream.
  const body = await readMessage();
  if (body && body.length > 0 && !h2Stream.closed && !h2Stream.destroyed) {
    h2Stream.end(body);
  } else {
    h2Stream.end();
  }
} else {
  // Streaming mode: forward all stdin messages as Connect frames.
  (async () => {
    while (true) {
      const msg = await readMessage();
      if (!msg || msg.length === 0) {
        // EOF or zero-length = done writing
        break;
      }
      if (!h2Stream.closed && !h2Stream.destroyed) {
        resetTimeout();
        h2Stream.write(msg);
      }
    }

    if (!h2Stream.closed && !h2Stream.destroyed) {
      h2Stream.end();
    }
  })();
}
