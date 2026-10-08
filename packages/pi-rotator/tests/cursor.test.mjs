import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createHash } from "node:crypto";
import http from "node:http";
import http2 from "node:http2";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { createBridgeHandle, lpEncode } from "../lib/cursor/bridge-handle.js";
import { createConnectFrameParser, frameConnectMessage } from "../lib/cursor/frames.js";
import { pollCursorAuth, refreshCursorToken } from "../lib/cursor/auth.js";
import { bridgeFactory, callCursorUnaryRpc } from "../lib/cursor/rpc.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createPayloadStream, prepareCursorPayload } from "../lib/provider-payload-stream.js";
import { createCursorAccounts } from "../lib/cursor.js";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { resumePendingExecWithToolResult } from "../lib/cursor/native-results.js";
import { processServerMessage } from "../lib/cursor/server-messages.js";
import piRotator from "../index.js";
import { stopProxy, setBridgeFactoryForTests, writeSSEStreamForTests, resumeCursorToolResultsForTests, __testInternals, getCursorModels, resolveModelId, resolveUsableModelId, startProxy, getProxyPort, parseMessages } from "../lib/cursor/proxy.js";
import { create, toBinary, fromBinary, toJson, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { buildCursorRequest, buildMcpToolDefinitions } from "../lib/cursor/request.js";
import { modelConfig, processModels } from "../lib/cursor/models.js";
import { createThinkingTagFilter } from "../lib/cursor/stream.js";
import { GetUsableModelsResponseSchema, AgentServerMessageSchema, AgentClientMessageSchema, ConversationTurnStructureSchema, ConversationStepSchema } from "../lib/cursor/proto/agent_pb.cjs";
import { registerSessionLifecycleCleanup } from "../lib/cursor/index.js";
import { ensureCursorProxy } from "../lib/cursor/cursor-shared.js";
import { handleStreamingResponse, handleNonStreamingResponse } from "../lib/cursor/responses.js";
import { conversationStates, activeBridges, cleanupBridge, commitConversationCheckpoint, deriveConversationKeyFromSessionId, deterministicConversationId } from "../lib/cursor/conversation-registry.js";

function fakePi() {
  const handlers = new Map();
  const providers = new Map();
  const commands = new Map();

  return {
    handlers, providers, commands,
    on(name, handler) {
      const rows = handlers.get(name) || [];
      rows.push(handler);
      handlers.set(name, rows);
    },
    registerProvider(id, def) { providers.set(id, def); },
    registerCommand(name, def) { commands.set(name, def); },
  };
}

async function bounded(label, work, timeoutMs = 5000) {
  let timer;

  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function token(subject) {
  return "header." + Buffer.from(JSON.stringify({ sub: subject })).toString("base64url") + ".signature";
}

test("standalone Cursor preparation reuses real catalogs, OAuth and cleanup without credentials or upstream requests", async () => {
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, legacy: process.env.PI_AGENT_DIR, offline: process.env.PI_OFFLINE };
  const originalFetch = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-"));
  const attempts = [];
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_AGENT_DIR = dir;
  process.env.PI_OFFLINE = "1";
  writeFileSync(join(dir, "settings.json"), "{}");
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { cursor: { modelOverrides: { "cursor-migration-future": { name: "saved newer Cursor model", contextWindow: 200000, maxTokens: 32000, input: ["text"], apiKey: "retired-proxy-key", headers: { authorization: "retired" } } } } } }));
  writeFileSync(join(dir, "auth.json"), "{}");
  globalThis.fetch = async url => { attempts.push(String(url)); throw new Error("upstream disabled"); };

  const pi = fakePi();

  try {
    await piRotator(pi);
    const command = pi.commands.get("rotator");
    assert.ok(command.getArgumentCompletions("add cursor")?.some(row => row.value === "add cursor"), "Cursor appears in account preparation");
    const ctx = { hasUI: false, modelRegistry: { getProvider: id => pi.providers.get(id) } };
    const text = await command.handler("add cursor", ctx);
    assert.match(text, /prepared cursor-account-2/);
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), "{}");
    const base = pi.providers.get("cursor");
    const alias = pi.providers.get("cursor-account-2");
    assert.ok(base && alias, "Cursor base and login alias are registered");
    assert.deepEqual(alias.models, [], "non-carrier siblings list nothing: one family entry in /model");
    const saved = base.models.find(model => model.id === "cursor-migration-future");
    assert.ok(saved, "the carrier includes newer saved IDs without obsolete proxy URLs");
    assert.equal(saved.apiKey, undefined);
    assert.equal(saved.headers, undefined);
    assert.equal(alias.baseUrl, base.baseUrl);
    assert.match(alias.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const ordinary = base.models.find(model => !model.id.endsWith("-fast") && base.models.some(row => row.id === model.id + "-fast"));
    assert.ok(ordinary, "real normal/fast counterparts survive extraction");
    assert.equal(alias.oauth.getApiKey({ access: "fixture-slot2" }), "fixture-slot2");
    assert.equal(base.oauth.getApiKey({ access: "fixture-base" }), "fixture-base");
    assert.equal(alias.streamSimple, base.streamSimple, "same proven request-scoped payload transport");
    const hookCount = pi.handlers.get("session_compact").length;
    assert.match(await bounded("second account preparation", command.handler("add cursor", ctx)), /prepared cursor-account-3/);
    assert.equal(pi.handlers.get("session_compact").length, hookCount, "account preparation does not duplicate cleanup hooks");
    assert.ok(pi.providers.get("cursor-account-2") === alias, "a new slot does not overwrite a working account catalog/auth definition");

    const overlapping = await bounded("overlapping account preparations", Promise.all([
      command.handler("add cursor", ctx), command.handler("add cursor", ctx),
    ]));

    assert.match(overlapping[0], /prepared cursor-account-4/);
    assert.match(overlapping[1], /prepared cursor-account-5/, "pending preparation must reserve its ID before another command chooses a slot");
    assert.ok(pi.providers.has("cursor-account-4") && pi.providers.has("cursor-account-5"), "both printed logins have registered providers");
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), "{}", "overlapping preparations still leave credentials untouched");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ cursor: { type: "oauth", access: token("already-owned") } }));
    const credentialSnapshot = readFileSync(join(dir, "auth.json"), "utf8");
    let catalogRequested = false;
    setBridgeFactoryForTests(() => { catalogRequested = true; throw new Error("catalog blocked until duplicate check"); });
    globalThis.fetch = async url => {
      if (String(url).includes("/auth/poll")) return new Response(JSON.stringify({ accessToken: token("already-owned"), refreshToken: "fixture-refresh" }), { status: 200 });
      catalogRequested = true;
      throw new Error("catalog must not run after duplicate login");
    };

    await assert.rejects(bounded("duplicate login guard", alias.oauth.login({ onAuth() {} })), /already logged in/);
    assert.equal(catalogRequested, false);
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), credentialSnapshot);
    const bridgeTokens = [];
    const responseBody = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, { models: [{ modelId: "reused-catalog-model", displayName: "Reused catalog model" }] }));
    setBridgeFactoryForTests(options => {
      bridgeTokens.push(options.accessToken);
      let dataCallback, closeCallback;

      return {
        proc: { kill() {} }, write() {},
        onData(callback) { dataCallback = callback; },
        onClose(callback) { closeCallback = callback; },
        end() { setImmediate(() => { dataCallback(responseBody); closeCallback(0); }); },
      };
    });
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://api2.cursor.sh/auth/exchange_user_api_key");
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer fixture-refresh-slot2");

      return new Response(JSON.stringify({ accessToken: token("refreshed-slot2"), refreshToken: "fixture-refreshed-slot2" }), { status: 200 });
    };

    const renewed = await alias.oauth.refreshToken({ access: "old-slot2", refresh: "fixture-refresh-slot2" });
    assert.equal(renewed.access, token("refreshed-slot2"));
    assert.equal(renewed.refresh, "fixture-refreshed-slot2");
    assert.deepEqual(bridgeTokens, [token("refreshed-slot2")], "catalog discovery uses the renewed selected account token");
    assert.deepEqual(pi.providers.get("cursor-account-2").models, [], "a discovered sibling stays hidden; its catalog joins the union");
    assert.ok(pi.providers.get("cursor").models.some(row => row.id === "reused-catalog-model"), "sibling discovery joins the carrier union");
    assert.ok(pi.providers.get("cursor").models.some(row => row.id === "cursor-migration-future"), "saved startup-only IDs persist until the carrier itself discovers");
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), credentialSnapshot, "SDK alone persists renewed credentials");
    const nextCatalog = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, { models: [{ modelId: "refresh-again-model", displayName: "Updated after refresh" }] }));
    setBridgeFactoryForTests(() => {
      let dataCallback, closeCallback;

      return { proc: { kill() {} }, write() {}, onData(callback) { dataCallback = callback; }, onClose(callback) { closeCallback = callback; }, end() { setImmediate(() => { dataCallback(nextCatalog); closeCallback(0); }); } };
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ accessToken: token("refreshed-again-slot2"), refreshToken: "fixture-again-refresh" }), { status: 200 });
    await pi.providers.get("cursor-account-2").oauth.refreshToken(renewed);
    assert.ok(pi.providers.get("cursor").models.some(row => row.id === "refresh-again-model"), "catalog updates survive re-registration on every refresh");
    assert.deepEqual(pi.providers.get("cursor-account-2").models, []);
    const baseCatalog = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, { models: [{ modelId: "base-live-model", displayName: "Base live model" }] }));
    setBridgeFactoryForTests(() => {
      let dataCallback, closeCallback;

      return { proc: { kill() {} }, write() {}, onData(callback) { dataCallback = callback; }, onClose(callback) { closeCallback = callback; }, end() { setImmediate(() => { dataCallback(baseCatalog); closeCallback(0); }); } };
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ accessToken: token("refreshed-base"), refreshToken: "fixture-base-refresh" }), { status: 200 });
    await pi.providers.get("cursor").oauth.refreshToken({ access: "old-base", refresh: "fixture-base-refresh" });
    assert.ok(pi.providers.get("cursor").models.some(row => row.id === "base-live-model"));
    assert.ok(pi.providers.get("cursor").models.some(row => row.id === "refresh-again-model"), "the union keeps sibling discoveries");
    assert.ok(!pi.providers.get("cursor").models.some(row => row.id === "cursor-migration-future"), "live carrier discovery supersedes saved startup-only IDs");
    const currentKey = deriveConversationKeyFromSessionId("cursor-current");
    const otherKey = deriveConversationKeyFromSessionId("cursor-other");
    const oldConversation = deterministicConversationId(currentKey);
    conversationStates.set(currentKey, { checkpoint: "fixture-current" });
    conversationStates.set(otherKey, { checkpoint: "fixture-other" });
    const sessionCtx = { sessionManager: { getSessionId: () => "cursor-current" } };

    for (const handler of pi.handlers.get("session_compact")) await handler({}, sessionCtx);
    assert.equal(conversationStates.has(currentKey), false, "compaction drops the old checkpoint");
    assert.notEqual(deterministicConversationId(currentKey), oldConversation, "compaction mints a new remote conversation identity");
    assert.equal(conversationStates.has(otherKey), true, "another session is untouched");
    conversationStates.set(currentKey, { checkpoint: "fixture-resumed" });

    for (const handler of pi.handlers.get("session_before_switch")) await handler({}, sessionCtx);
    assert.equal(conversationStates.has(currentKey), false);
    assert.equal(deterministicConversationId(currentKey), oldConversation, "ending the session drops its generation state");
    assert.equal(conversationStates.has(otherKey), true);
    const foreignPi = fakePi();
    const emptyDir = mkdtempSync(join(tmpdir(), "rotator-cursor-owner-"));
    process.env.PI_CODING_AGENT_DIR = emptyDir;
    writeFileSync(join(emptyDir, "auth.json"), "{}");
    await bounded("foreign owner initialization", piRotator(foreignPi));
    const foreignCommand = foreignPi.commands.get("rotator").handler;

    const failed = await foreignCommand("add cursor", { modelRegistry: { getProvider(id) {
      if (id === "cursor") throw new Error("host lookup unavailable");

      return undefined;
    } } });

    assert.match(failed, /registration rejected/);
    const foreign = { id: "cursor", customProtocol: true };
    const refusal = await foreignCommand("add cursor", { modelRegistry: { getProvider: id => id === "cursor" ? foreign : undefined } });
    assert.match(refusal, /provider package owns cursor/);
    assert.equal(foreignPi.providers.size, 0, "existing owner is never replaced by preparation");
    const retry = await foreignCommand("add cursor", { modelRegistry: { getProvider: id => foreignPi.providers.get(id) } });
    assert.match(retry, /prepared cursor-account-2/, "failed or refused preparations release their reserved IDs");
    assert.deepEqual(attempts, []);

    for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_compact", "session_shutdown"]) {
      assert.ok(pi.handlers.has(event), "existing Cursor cleanup hook retained: " + event);
    }
  } finally {
    stopProxy();
    setBridgeFactoryForTests(undefined);
    globalThis.fetch = originalFetch;

    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;

    if (previous.legacy === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previous.legacy;

    if (previous.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous.offline;
  }
});

function streamFixture() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const chunks = [];
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  res.writeHead = () => { res.headersSent = true; };

  res.flushHeaders = () => {};

  res.write = chunk => { chunks.push(String(chunk)); 

    return true; };

  res.end = () => { res.writableEnded = true; complete(); };

  const listeners = {};
  const sent = [];

  const bridge = {
    alive: true, proc: { kill() { bridge.close(); } },
    onData(listener) { listeners.data = listener; },
    onClose(listener) { listeners.close = listener; },
    write(bytes) { sent.push(Buffer.from(bytes)); },
    end() {},
    destroy() { if (bridge.alive) bridge.close(); },
    close(code = 0) { bridge.alive = false; listeners.close?.(code); },
    endStream(payload) {
      const bytes = Buffer.from(JSON.stringify(payload));
      const frame = Buffer.alloc(bytes.length + 5);
      frame[0] = 2;
      frame.writeUInt32BE(bytes.length, 1);
      frame.set(bytes, 5);
      listeners.data(frame.subarray(0, 2));
      listeners.data(frame.subarray(2));
    },
    push(message) {
      const bytes = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message));
      const frame = Buffer.alloc(bytes.length + 5);
      frame.writeUInt32BE(bytes.length, 1);
      frame.set(bytes, 5);
      listeners.data(frame.subarray(0, 2));
      listeners.data(frame.subarray(2));
    },
  };

  const packets = () => chunks.flatMap(chunk => chunk.startsWith("data: {") ? [JSON.parse(chunk.slice(6))] : []);

  return { req, res, bridge, sent, done, packets, body: () => chunks.join("") };
}

function interaction(caseName, value = {}) {
  return { message: { case: "interactionUpdate", value: { message: { case: caseName, value } } } };
}

test("Cursor wire stream preserves fragmented frames, native tool pause and same-tick resumed output", async () => {
  const first = streamFixture();
  const second = streamFixture();
  const bridgeKey = "fixture-stream-bridge";
  const convKey = "fixture-stream-conversation";
  const currentTurn = { userText: "read a fixture", steps: [] };
  const options = { modelId: "fixture-model", bridgeKey, convKey, completedTurns: [], currentTurn };

  try {
    writeSSEStreamForTests({ ...options, req: first.req, res: first.res, bridge: first.bridge, mcpTools: [{ name: "read" }], promptTokenEstimate: 25 });
    first.bridge.push(interaction("textDelta", { text: "before tool" }));
    first.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: "fixture-exec", message: { case: "readArgs", value: { path: "/fixture.txt" } } } } });
    await bounded("tool pause", first.done);
    const packets = first.packets();
    const call = packets.flatMap(packet => packet.choices).flatMap(choice => choice.delta.tool_calls || [])[0];
    assert.equal(call.function.name, "read");
    assert.deepEqual(JSON.parse(call.function.arguments), { path: "/fixture.txt" });
    assert.equal(packets.at(-2).choices[0].finish_reason, "tool_calls");
    assert.deepEqual(packets.at(-1).usage, { prompt_tokens: 25, completion_tokens: 0, total_tokens: 25 });
    assert.equal(first.bridge.alive, true, "a tool pause preserves the same bridge");
    const active = __testInternals.activeBridges.get(bridgeKey);
    const write = first.bridge.write;
    first.bridge.write = bytes => {
      write(bytes);
      const reply = fromBinary(AgentClientMessageSchema, Buffer.from(bytes).subarray(5));

      if (reply.message.case !== "execClientMessage") return;
      assert.equal(reply.message.value.message.case, "readResult");
      assert.match(JSON.stringify(toJson(AgentClientMessageSchema, reply)), /fixture result/);
      first.bridge.push(interaction("textDelta", { text: "after tool" }));
      first.bridge.push(interaction("tokenDelta", { tokens: 3 }));
      first.bridge.push(interaction("turnEnded"));
    };

    resumeCursorToolResultsForTests(active, [{ toolCallId: call.id, content: "fixture result" }], second.req, second.res, options);
    assert.equal(second.res.writableEnded, true, "turnEnded closes the resumed response in the same tick");
    await bounded("same-tick resume", second.done);
    const resumed = second.packets();
    assert.equal(resumed.flatMap(packet => packet.choices).map(choice => choice.delta.content || "").join(""), "after tool");
    assert.equal(resumed.at(-2).choices[0].finish_reason, "stop");
    assert.deepEqual(resumed.at(-1).usage, { prompt_tokens: 0, completion_tokens: 3, total_tokens: 3 });
    assert.ok(resumed.every(packet => packet.id === resumed[0].id && packet.model === "fixture-model"));
    assert.equal(currentTurn.steps.find(step => step.kind === "toolCall").result.content, "fixture result");
  } finally {
    first.bridge.close();
    stopProxy();
  }
});

async function nativeBashCall(execCase, args) {
  const f = streamFixture();
  const bridgeKey = "native-" + args.toolCallId;
  const options = { modelId: "fixture-model", bridgeKey, convKey: bridgeKey, completedTurns: [], currentTurn: { userText: "fixture tool", steps: [] } };

  try {
    writeSSEStreamForTests({ ...options, req: f.req, res: f.res, bridge: f.bridge, mcpTools: [{ name: "bash" }] });
    f.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: args.toolCallId, message: { case: execCase, value: args } } } });
    await bounded("native Bash pause", f.done);
    const call = f.packets().flatMap(packet => packet.choices).flatMap(choice => choice.delta.tool_calls || [])[0];
    assert.equal(call.function.name, "bash");

    return JSON.parse(call.function.arguments);
  } finally {
    f.bridge.close();
    stopProxy();
  }
}

test("Cursor native shells honor working directories through Pi's command-only Bash interface", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rotator-shell-")));
  const target = join(root, "project's files");
  mkdirSync(target);

  for (const execCase of ["shellArgs", "shellStreamArgs"]) {
    const args = await nativeBashCall(execCase, { command: "printf '%s' \"$PWD\"", workingDirectory: target, toolCallId: execCase });
    const output = execFileSync("/bin/sh", ["-c", args.command], { cwd: root, encoding: "utf8" });

    assert.equal(output, target, "Pi executes command, not the unsupported cwd property");

    const invalid = await nativeBashCall(execCase, { command: "printf unsafe > unexpected.txt", workingDirectory: join(root, "missing"), toolCallId: execCase + "-missing" });

    assert.throws(() => execFileSync("/bin/sh", ["-c", invalid.command], { cwd: root, stdio: "pipe" }));
    assert.equal(existsSync(join(root, "unexpected.txt")), false, "failed directory changes never run the command in the host directory");
  }
});

test("Cursor grep fallback preserves glob and treats leading-dash patterns as data", async () => {
  const root = mkdtempSync(join(tmpdir(), "rotator-grep-"));
  writeFileSync(join(root, "wanted.txt"), "-needle in text\n--hidden in text\n");
  writeFileSync(join(root, "excluded.js"), "-needle in code\n");

  const args = await nativeBashCall("grepArgs", { pattern: "-needle", path: root, glob: "*.txt", toolCallId: "grep-option-pattern" });
  const output = execFileSync("rg", ["--no-config", "--files", root], { encoding: "utf8" });

  assert.match(output, /wanted\.txt/, "fixture is searchable by the installed ripgrep");

  const result = execFileSync("/bin/sh", ["-c", args.command], { cwd: root, encoding: "utf8", env: { ...process.env, RIPGREP_CONFIG_PATH: "" } });

  assert.match(result, /wanted\.txt:1:-needle in text/);
  assert.doesNotMatch(result, /excluded\.js/, "native glob still limits the search when only Bash is exposed");

  const option = await nativeBashCall("grepArgs", { pattern: "--hidden", path: root, glob: "*.txt", toolCallId: "grep-long-option-pattern" });
  const literal = execFileSync("/bin/sh", ["-c", option.command], { cwd: root, encoding: "utf8", env: { ...process.env, RIPGREP_CONFIG_PATH: "" } });

  assert.match(literal, /wanted\.txt:2:--hidden in text/, "a pattern equal to an option remains a literal search pattern");
});

async function nativeToolRoundTrip(execCase, args, toolName, runTool, isError = false, expectedCase = isError ? "error" : "success") {
  const first = streamFixture();
  const second = streamFixture();
  const bridgeKey = "roundtrip-" + args.toolCallId;
  const options = { modelId: "fixture", bridgeKey, convKey: bridgeKey, completedTurns: [], currentTurn: { userText: "native fixture", steps: [] } };
  let reply;

  try {
    writeSSEStreamForTests({ ...options, bridge: first.bridge, req: first.req, res: first.res, mcpTools: [{ name: toolName }] });
    first.bridge.push({ message: { case: "execServerMessage", value: { id: 2, execId: args.toolCallId, message: { case: execCase, value: args } } } });
    await bounded("native fixture pause", first.done);
    const call = first.packets().flatMap(packet => packet.choices).flatMap(choice => choice.delta.tool_calls || [])[0];
    const content = runTool(JSON.parse(call.function.arguments));
    const active = activeBridges.get(bridgeKey);
    first.bridge.write = bytes => {
      const message = fromBinary(AgentClientMessageSchema, Buffer.from(bytes).subarray(5));

      if (message.message.case === "execClientMessage") reply = message.message.value.message.value.result;
      else if (message.message.case === "execClientControlMessage") reply = message.message.value.message;
      else return;

      first.bridge.push(interaction("turnEnded"));
    };

    const stderr = console.error;
    const leaked = [];
    console.error = (...args) => leaked.push(args);

    try {
      resumeCursorToolResultsForTests(active, [{ toolCallId: call.id, content, isError }], second.req, second.res, options);
    } finally {
      console.error = stderr;
    }

    assert.deepEqual(leaked, [], "native result rejection must not print over the host TUI");
    await bounded("native fixture resumed", second.done);
    assert.equal(reply.case, expectedCase);

    return reply.value;
  } finally {
    first.bridge.close();
    stopProxy();
  }
}

test("Cursor native binary writes are rejected before any text tool can truncate a file", () => {
  const f = streamFixture();
  const root = mkdtempSync(join(tmpdir(), "rotator-binary-"));
  const path = join(root, "preserve.bin");
  const original = Buffer.from([0, 255, 128, 1]);
  writeFileSync(path, original);

  try {
    writeSSEStreamForTests({ bridge: f.bridge, req: f.req, res: f.res, modelId: "fixture", bridgeKey: "binary-write", convKey: "binary-write", completedTurns: [], currentTurn: { userText: "fixture", steps: [] }, mcpTools: [{ name: "write" }, { name: "bash" }] });
    f.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: "binary", message: { case: "writeArgs", value: { path, fileBytes: original } } } } });
    const reply = f.sent.map(bytes => fromBinary(AgentClientMessageSchema, bytes.subarray(5))).find(message => message.message.case === "execClientMessage");

    assert.equal(reply?.message.value.message.case, "writeResult");
    assert.equal(reply.message.value.message.value.result.case, "rejected");
    assert.deepEqual(readFileSync(path), original);
    assert.equal(activeBridges.has("binary-write"), false);
    f.bridge.push(interaction("turnEnded"));
  } finally {
    f.bridge.close();
    stopProxy();
  }
});

test("Cursor native writes report file bytes and contents, not Pi's success acknowledgement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rotator-write-result-"));
  const path = join(dir, "fixture.txt");
  const text = "café\nsecond line\n";

  const result = await nativeToolRoundTrip("writeArgs", { path, fileText: text, returnFileContentAfterWrite: true, toolCallId: "text-write" }, "write", args => {
    writeFileSync(args.path, args.content);

    return "Successfully wrote to " + args.path;
  });

  assert.equal(readFileSync(path, "utf8"), text);
  assert.equal(result.fileContentAfterWrite, text);
  assert.equal(result.fileSize, Buffer.byteLength(text));

  const omitted = await nativeToolRoundTrip("writeArgs", { path, fileText: "", toolCallId: "empty-write" }, "write", args => {
    writeFileSync(args.path, args.content);

    return "Successfully wrote to " + args.path;
  });

  assert.equal(readFileSync(path, "utf8"), "");
  assert.equal(omitted.fileSize, 0);
  assert.equal(omitted.fileContentAfterWrite, undefined);
});

test("Cursor native search and listing results preserve actual locations and directory kinds", async () => {
  const root = mkdtempSync(join(tmpdir(), "rotator-native-results-"));
  mkdirSync(join(root, "subdirectory"));
  writeFileSync(join(root, "a.txt"), "first\nneedle A\n");
  writeFileSync(join(root, "b.txt"), "first\nsecond\nneedle B\n");
  writeFileSync(join(root, ".hidden"), "fixture");

  for (const toolName of ["grep", "bash"]) {
    const result = await nativeToolRoundTrip("grepArgs", { path: root, pattern: "NEEDLE", caseInsensitive: true, glob: "*.txt", toolCallId: "search-" + toolName }, toolName, args => toolName === "bash" ? execFileSync("/bin/sh", ["-c", args.command], { encoding: "utf8" }) : args.ignoreCase ? "a.txt:2: needle A\nb.txt:3: needle B" : "No matches found");
    const content = result.workspaceResults[root].result.value;

    assert.equal(content.matches.length, 2);
    assert.deepEqual(content.matches.map(file => ({ file: file.file.split("/").at(-1), line: file.matches[0].lineNumber, text: file.matches[0].content })), [{ file: "a.txt", line: 2, text: "needle A" }, { file: "b.txt", line: 3, text: "needle B" }]);
    const absent = await nativeToolRoundTrip("grepArgs", { path: root, pattern: "not-in-fixture", toolCallId: "empty-search-" + toolName }, toolName, args => toolName === "bash" ? execFileSync("/bin/sh", ["-c", args.command], { encoding: "utf8" }) : "No matches found");

    assert.equal(absent.workspaceResults[root].result.value.matches.length, 0, "empty searches do not fabricate a matching line");
  }

  for (const toolName of ["bash", "ls"]) {
    const result = await nativeToolRoundTrip("lsArgs", { path: root, toolCallId: "listing-" + toolName }, toolName, args => toolName === "bash" ? execFileSync("/bin/sh", ["-c", args.command], { encoding: "utf8" }) : ".hidden\na.txt\nb.txt\nsubdirectory/");

    assert.deepEqual(result.directoryTreeRoot.childrenFiles.map(file => file.name), [".hidden", "a.txt", "b.txt"]);
    assert.equal(result.directoryTreeRoot.childrenDirs[0].absPath, join(root, "subdirectory"));
    assert.equal(result.directoryTreeRoot.numFiles, 3);
    const emptyRoot = mkdtempSync(join(tmpdir(), "rotator-empty-directory-"));
    const empty = await nativeToolRoundTrip("lsArgs", { path: emptyRoot, toolCallId: "empty-listing-" + toolName }, toolName, args => toolName === "bash" ? execFileSync("/bin/sh", ["-c", args.command], { encoding: "utf8" }) : "(empty directory)", false, toolName === "ls" ? "throw" : "success");

    if (toolName === "ls") assert.equal(empty.id, 2, "ambiguous Pi text must reject the actual pending exec, not invent an empty tree");
    else {
      assert.equal(empty.directoryTreeRoot.childrenFiles.length, 0);
      assert.equal(empty.directoryTreeRoot.childrenDirs.length, 0);
    }

    writeFileSync(join(emptyRoot, "(empty directory)"), "fixture");
    const literal = await nativeToolRoundTrip("lsArgs", { path: emptyRoot, toolCallId: "literal-listing-" + toolName }, toolName, args => toolName === "bash" ? execFileSync("/bin/sh", ["-c", args.command], { encoding: "utf8" }) : "(empty directory)", false, toolName === "ls" ? "throw" : "success");

    if (toolName === "ls") assert.equal(literal.id, 2);
    else assert.deepEqual(literal.directoryTreeRoot.childrenFiles.map(file => file.name), ["(empty directory)"], "Bash has no empty-directory sentinel, so this is a real filename");
  }
});

test("Cursor native listings reject ignore and timeout semantics absent from Pi ls", () => {
  for (const options of [{ ignore: ["*.secret"] }, { timeoutMs: 1000 }]) {
    const f = streamFixture();

    try {
      writeSSEStreamForTests({ bridge: f.bridge, req: f.req, res: f.res, modelId: "fixture", bridgeKey: "unsupported-ls", convKey: "unsupported-ls", completedTurns: [], currentTurn: { userText: "fixture", steps: [] }, mcpTools: [{ name: "ls" }, { name: "bash" }] });
      f.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: "unsupported", message: { case: "lsArgs", value: { path: "/fixture", ...options } } } } });
      const reply = f.sent.map(bytes => fromBinary(AgentClientMessageSchema, bytes.subarray(5))).find(message => message.message.case === "execClientMessage");

      assert.equal(reply?.message.value.message.case, "lsResult");
      assert.equal(reply.message.value.message.value.result.case, "rejected");
      f.bridge.push(interaction("turnEnded"));
    } finally {
      f.bridge.close();
      stopProxy();
    }
  }
});

test("Cursor native grep rejects unsupported search modes rather than silently changing semantics", () => {
  for (const options of [{ outputMode: "files_with_matches" }, { multiline: true }, { type: "js" }, { contextBefore: 2, contextAfter: 1 }, { sort: "path" }, { context: 1 }, { contextBefore: 2 }, { contextAfter: 1 }, { headLimit: 10 }, { sortAscending: false }, { sortAscending: true }]) {
    const f = streamFixture();

    try {
      writeSSEStreamForTests({ bridge: f.bridge, req: f.req, res: f.res, modelId: "fixture", bridgeKey: "unsupported-grep", convKey: "unsupported-grep", completedTurns: [], currentTurn: { userText: "fixture", steps: [] }, mcpTools: [{ name: "grep" }, { name: "bash" }] });
      f.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: "unsupported", message: { case: "grepArgs", value: { pattern: "fixture", ...options } } } } });
      const reply = f.sent.map(bytes => fromBinary(AgentClientMessageSchema, bytes.subarray(5))).find(message => message.message.case === "execClientMessage");

      assert.equal(reply?.message.value.message.case, "grepResult");
      assert.equal(reply.message.value.message.value.result.case, "error");
      f.bridge.push(interaction("turnEnded"));
    } finally {
      f.bridge.close();
      stopProxy();
    }
  }
});

test("Cursor tool errors survive payload shaping, transcript replay and native resume", async () => {
  const id = "failed-write";
  const error = "Read-only filesystem";
  const payload = { messages: [{ role: "user", content: "write fixture" }, { role: "assistant", content: null, tool_calls: [{ id, function: { name: "write", arguments: "{}" } }] }, { role: "tool", tool_call_id: id, content: error }] };
  const context = { messages: [{ role: "toolResult", toolCallId: id, isError: true, content: [{ type: "text", text: error }] }] };
  let requestPending;
  const stream = createPayloadStream(prepareCursorPayload, () => ({ streamSimple(model, _context, options) { requestPending = options.onPayload(payload, model); } }));
  stream({ api: "openai-completions" }, context, { sessionId: "fixture-errors" });
  const body = await requestPending;
  const parsed = parseMessages(body.messages, body.pi_tool_result_errors);

  assert.equal(body.pi_session_id, "fixture-errors");
  assert.deepEqual(body.pi_tool_result_errors, [id]);
  assert.equal(parsed.toolResults[0].isError, true);
  assert.equal(parsed.pendingTurn.steps.at(-1).result.isError, true, "rebuilding history does not rewrite errors as success");
  const result = await nativeToolRoundTrip("writeArgs", { path: "/fixture.txt", fileText: "must not claim this was written", toolCallId: id }, "write", () => parsed.toolResults[0].content, parsed.toolResults[0].isError);

  assert.equal(result.error, error);
});

test("Cursor error metadata follows the host's normalized cross-provider tool IDs", async () => {
  const id = "call/unsafe:tool|item_other";
  const model = { id: "fixture", name: "fixture", provider: "cursor", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", input: ["text"], reasoning: false, contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const context = { messages: [{ role: "user", content: "fixture", timestamp: 1 }, { role: "assistant", content: [{ type: "toolCall", id, name: "write", arguments: { path: "/fixture", content: "fixture" } }], provider: "anthropic", api: "anthropic-messages", model: "other-model", stopReason: "toolUse", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, { role: "toolResult", toolCallId: id, toolName: "write", content: [{ type: "text", text: "Permission denied" }], isError: true, timestamp: 3 }] };
  const previous = globalThis.fetch;
  let body;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("Network forbidden in fixture"); };

  const stream = createPayloadStream(prepareCursorPayload, () => ({ streamSimple(actualModel, actualContext, options) {
    return getApiProvider("openai-completions").streamSimple(actualModel, actualContext, { ...options, onPayload: async (...args) => {
      body = await options.onPayload(...args);
      throw new Error("Fixture captured request before transport");
    } });
  } }));

  try {
    await stream(model, context, { apiKey: "fixture" }).result();
    const wireId = body.messages.find(message => message.role === "tool").tool_call_id;
    const parsed = parseMessages(body.messages, body.pi_tool_result_errors);

    assert.notEqual(wireId, id, "fixture actually reaches the host's cross-provider ID normalization");
    assert.ok(body.pi_tool_result_errors.includes(wireId));
    assert.equal(parsed.toolResults[0].isError, true);

    const succeeded = { messages: context.messages.map(message => message.role === "toolResult" ? { ...message, isError: false, content: [{ type: "text", text: "Successfully wrote fixture" }] } : message) };
    await stream(model, succeeded, { apiKey: "fixture", onPayload: payload => Object.assign(body, payload) }).result();
    const resumed = parseMessages(body.messages, body.pi_tool_result_errors);

    assert.equal(resumed.toolResults[0].isError, undefined, "reusing a caller payload must not carry a previous failure into a successful request");
    let frozen;
    body = undefined;
    await stream(model, context, { apiKey: "fixture", sessionId: "frozen-fixture", onPayload: payload => {
      frozen = Object.freeze(payload);

      return frozen;
    } }).result();

    assert.ok(body, "a valid frozen payload callback must not prevent request preparation");
    assert.equal(body.pi_session_id, "frozen-fixture");
    assert.equal(parseMessages(body.messages, body.pi_tool_result_errors).toolResults[0].isError, true);
    assert.equal(Object.hasOwn(frozen, "pi_session_id"), false, "private routing metadata must not mutate caller-owned payloads");
    assert.equal(body.messages, frozen.messages, "only the top-level record is owned; native nested values retain identity");
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("Cursor rejects ambiguous grep locations instead of fabricating a filename and line", () => {
  for (const toolName of ["grep", "bash"]) {
    const sent = [];
    const content = toolName === "grep" ? "name:12:file.txt:7: needle" : "/fixture/name:12:file.txt:7:needle";
    resumePendingExecWithToolResult({ execId: "ambiguous-search", execMsgId: 4, resultCase: "grepResult", toolName, nativeArgs: { pattern: "needle", path: "/fixture" } }, content, false, bytes => sent.push(fromBinary(AgentClientMessageSchema, bytes.subarray(5))));

    assert.equal(sent[0].message.case, "execClientControlMessage");
    assert.equal(sent[0].message.value.message.case, "throw");
    assert.equal(sent[0].message.value.message.value.id, 4);
  }
});

test("Cursor rejects truncated native reads instead of claiming partial output is the full file", () => {
  for (const content of ["tail of a long line\n\n[Showing last 50KB of line 1 (line is 100KB). Full output: /fixture/pi-bash.log]", "first line\n\n[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]", "[Line 1 is 100KB, exceeds 50KB limit. Use bash: sed -n '1p' /fixture | head -c 51200]", "first line\n\n[20 more lines in file. Use offset=2 to continue.]"]) {
    const sent = [];
    resumePendingExecWithToolResult({ execId: "partial-read", execMsgId: 5, resultCase: "readResult", nativeArgs: { path: "/fixture" } }, content, false, bytes => sent.push(fromBinary(AgentClientMessageSchema, bytes.subarray(5))));

    assert.equal(sent[0].message.case, "execClientControlMessage");
    assert.equal(sent[0].message.value.message.case, "throw");
  }
});

test("Cursor native shells reject timing/background semantics that Pi Bash cannot faithfully translate", () => {
  for (const options of [{ timeout: 1000 }, { hardTimeout: 1000 }, { isBackground: true }]) {
    const f = streamFixture();

    try {
      writeSSEStreamForTests({ bridge: f.bridge, req: f.req, res: f.res, modelId: "fixture", bridgeKey: "unsupported-shell", convKey: "unsupported-shell", completedTurns: [], currentTurn: { userText: "fixture", steps: [] }, mcpTools: [{ name: "bash" }] });
      f.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: "unsupported", message: { case: "shellArgs", value: { command: "printf fixture", ...options } } } } });
      const reply = f.sent.map(bytes => fromBinary(AgentClientMessageSchema, bytes.subarray(5))).find(message => message.message.case === "execClientMessage");

      assert.equal(reply?.message.value.message.case, "shellResult");
      assert.equal(reply.message.value.message.value.result.case, "rejected");
      f.bridge.push(interaction("turnEnded"));
    } finally {
      f.bridge.close();
      stopProxy();
    }
  }
});

test("Cursor empty deltas cannot keep an unproductive Run alive", async t => {
  const previous = { useful: process.env.PI_CURSOR_UPSTREAM_STALL_MS, transport: process.env.PI_CURSOR_TRANSPORT_STALL_MS };
  process.env.PI_CURSOR_UPSTREAM_STALL_MS = "40";
  process.env.PI_CURSOR_TRANSPORT_STALL_MS = "1000";

  try {
    for (const mode of ["SSE", "JSON", "JSON rejected tools"]) await t.test(mode, async () => {
      const stream = mode === "SSE";
      const rejectedTools = mode === "JSON rejected tools";
      const f = streamFixture();
      const convKey = "empty-delta-stall";
      const blobStore = new Map();
      const currentTurn = { userText: "fixture", steps: [] };
      conversationStates.set(convKey, { blobStore, checkpoint: null });
      let json;
      let collecting;
      let timer;
      const end = f.res.end;
      f.res.end = value => { if (value) json = JSON.parse(value); end(); };

      try {
        if (stream) writeSSEStreamForTests({ bridge: f.bridge, bridgeKey: convKey, convKey, blobStore, modelId: "fixture", completedTurns: [], currentTurn, req: f.req, res: f.res, mcpTools: [] });
        else {
          setBridgeFactoryForTests(() => f.bridge);
          collecting = handleNonStreamingResponse({ requestBytes: new Uint8Array(), blobStore, mcpTools: rejectedTools ? [{ name: "read" }] : [] }, "fixture", "fixture", convKey, [], currentTurn, f.req, f.res);
        }

        let frames = 0;
        timer = setInterval(() => {
          if (rejectedTools) f.bridge.push({ message: { case: "execServerMessage", value: { id: frames + 1, execId: "rejected-read-" + frames, message: { case: "readArgs", value: { path: "/fixture.txt" } } } } });
          else {
            f.bridge.push(interaction("textDelta"));
            f.bridge.push(interaction("thinkingDelta"));
            f.bridge.push(interaction("tokenDelta", { tokens: 0 }));
          }

          if (++frames === 50) { clearInterval(timer); f.bridge.push(interaction("turnEnded")); }
        }, 5);
        await bounded("empty-output deadline", f.done);

        if (stream) assert.ok(f.packets().some(packet => packet.error?.type === "upstream_error" && /stalled.*workspace and session state unchanged/.test(packet.error.message)), "streaming stall errors reassure against workspace-loss confabulation");
        else assert.equal(json.error?.type, "upstream_error");

        if (rejectedTools) {
          const replies = f.sent.map(bytes => fromBinary(AgentClientMessageSchema, bytes.subarray(5)).message).filter(message => message.case === "execClientMessage");
          assert.ok(replies.some(message => message.value.message.case === "readResult" && message.value.message.value.result.case === "error"));
        }

        assert.equal(f.bridge.alive, false);
        assert.equal(conversationStates.has(convKey), false);
      } finally {
        clearInterval(timer);
        f.bridge.close();

        if (collecting) await collecting;
        stopProxy();
        setBridgeFactoryForTests();
      }
    });
  } finally {
    if (previous.useful === undefined) delete process.env.PI_CURSOR_UPSTREAM_STALL_MS;
    else process.env.PI_CURSOR_UPSTREAM_STALL_MS = previous.useful;

    if (previous.transport === undefined) delete process.env.PI_CURSOR_TRANSPORT_STALL_MS;
    else process.env.PI_CURSOR_TRANSPORT_STALL_MS = previous.transport;
  }
});

test("Cursor unadvertised MCP tools are terminally rejected and do not count as progress", () => {
  const sent = [];
  const forwarded = [];
  const request = (name, providerIdentifier = "pi") => create(AgentServerMessageSchema, { message: { case: "execServerMessage", value: { id: 8, execId: name, message: { case: "mcpArgs", value: { toolName: name, toolCallId: name, providerIdentifier } } } } });
  const dispatch = message => processServerMessage(message, new Map(), [{ name: "read" }], bytes => sent.push(fromBinary(AgentClientMessageSchema, bytes.subarray(5))), { outputTokens: 0 }, () => {}, exec => forwarded.push(exec));
  const stderr = console.error;
  let unavailable;

  try {
    console.error = () => { throw new Error("stderr is unavailable"); };

    assert.doesNotThrow(() => { unavailable = dispatch(request("write")); }, "stderr failure cannot prevent terminal tool rejection");
  } finally {
    console.error = stderr;
  }

  assert.equal(forwarded.length, 0, "an upstream call cannot expand Pi's advertised tool set");
  assert.equal(unavailable.countsAsProgress, false);
  assert.equal(sent[0].message.case, "execClientControlMessage");
  assert.equal(sent[0].message.value.message.case, "throw");
  const foreign = dispatch(request("read", "foreign-server"));

  assert.equal(forwarded.length, 0, "a foreign server namespace cannot execute a same-named Pi tool");
  assert.equal(foreign.countsAsProgress, false);
  const available = dispatch(request("read"));

  assert.equal(forwarded[0].toolName, "read");
  assert.equal(available.countsAsProgress, true);
});

test("Cursor HTTP continuations preserve failed native tool results through the whole loopback path", async () => {
  const f = streamFixture();
  const id = "http-failed-write";
  let native;
  f.bridge.write = bytes => {
    const message = fromBinary(AgentClientMessageSchema, bytes.subarray(5));

    if (message.message.case === "runRequest") queueMicrotask(() => f.bridge.push({ message: { case: "execServerMessage", value: { id: 9, execId: id, message: { case: "writeArgs", value: { path: "/fixture.txt", fileText: "not written", toolCallId: id } } } } }));

    if (message.message.case === "execClientMessage") {
      native = message.message.value.message.value.result;
      f.bridge.push(interaction("textDelta", { text: "failure observed" }));
      f.bridge.push(interaction("turnEnded"));
    }
  };

  setBridgeFactoryForTests(() => f.bridge);

  try {
    const port = await startProxy(async () => "fixture-http-token");
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const headers = { "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" };
    const body = { model: "fixture", pi_session_id: "http-error-continuation", messages: [{ role: "user", content: "write fixture" }], tools: [{ type: "function", function: { name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } }], stream: true };
    const first = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const text = await first.text();
    const packets = text.split("\n").flatMap(line => line.startsWith("data: {") ? [JSON.parse(line.slice(6))] : []);
    const call = packets.flatMap(packet => packet.choices).flatMap(choice => choice.delta.tool_calls || [])[0];
    const messages = [...body.messages, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "Read-only filesystem" }];
    const second = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, messages, pi_tool_result_errors: [call.id] }), signal: AbortSignal.timeout(5000) });
    const resumed = await second.text();

    assert.equal(native.case, "error");
    assert.equal(native.value.error, "Read-only filesystem");
    assert.match(resumed, /failure observed/);
    assert.match(resumed, /"finish_reason":"stop"/);
    assert.equal(activeBridges.size, 0);
  } finally {
    f.bridge.close();
    stopProxy();
    setBridgeFactoryForTests();
  }
});

test("Cursor discovered catalogs and effort fallback are credential-scoped", async () => {
  setBridgeFactoryForTests(options => {
    const modelId = options.accessToken === "review-catalog-a" ? "review-effort-low" : "review-effort-high";
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, { models: [{ modelId, displayName: modelId }] }));
    let data, close;

    return { proc: { kill() {} }, write() {}, onData(fn) { data = fn; }, onClose(fn) { close = fn; }, end() { setImmediate(() => { data(body); close(0); }); } };
  });

  try {
    assert.deepEqual((await getCursorModels("review-catalog-a")).map(model => model.id), ["review-effort-low"]);
    assert.deepEqual((await getCursorModels("review-catalog-b")).map(model => model.id), ["review-effort-high"]);
    assert.equal(resolveUsableModelId("review-effort", "review-catalog-a"), "review-effort-low");
    assert.equal(resolveUsableModelId("review-effort", "review-catalog-b"), "review-effort-high");
  } finally {
    setBridgeFactoryForTests();
  }
});

test("resolveModelId never double-appends an effort already in the model id", () => {
  assert.equal(resolveModelId("cursor-grok-4.6", "high"), "cursor-grok-4.6-high");
  assert.equal(resolveModelId("cursor-grok-4.6-fast", "high"), "cursor-grok-4.6-high-fast");
  assert.equal(resolveModelId("cursor-grok-4.6-high", "high"), "cursor-grok-4.6-high");
  assert.equal(resolveModelId("cursor-grok-4.6-high-fast", "high"), "cursor-grok-4.6-high-fast");
  assert.equal(resolveModelId("cursor-grok-4.6", ""), "cursor-grok-4.6");
});

test("Cursor HTTP tool continuations honor the selected account, model and response format", async t => {
  for (const mode of ["account", "model", "nonstream", "same", "system", "history", "user", "rewind", "tools", "new-turn", "completed-edit", "completed-same", "rebuild-resume", "rebuild-prefix-result"]) await t.test(mode, async () => {
    const runs = [];
    setBridgeFactoryForTests(options => {
      const fixture = streamFixture();
      fixture.bridge.write = bytes => {
        const message = fromBinary(AgentClientMessageSchema, Buffer.from(bytes).subarray(5));

        if (message.message.case === "runRequest") {
          const run = { token: options.accessToken, model: message.message.value.modelDetails.modelId, id: message.message.value.conversationId, roots: message.message.value.conversationState.rootPromptMessagesJson };
          runs.push(run);
          queueMicrotask(() => {
            if (runs.length === 1) {
              fixture.bridge.push({ message: { case: "conversationCheckpointUpdate", value: { rootPromptMessagesJson: [Buffer.from("checkpoint-root")] } } });
              fixture.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: "review-read", message: { case: "readArgs", value: { path: "/review.txt" } } } } });

              if (mode === "rebuild-prefix-result") fixture.bridge.push({ message: { case: "execServerMessage", value: { id: 3, execId: "unresolved-read", message: { case: "readArgs", value: { path: "/unresolved.txt" } } } } });
            }
            else if (["rebuild-resume", "rebuild-prefix-result"].includes(mode) && runs.length === 2) {
              fixture.bridge.push({ message: { case: "conversationCheckpointUpdate", value: { rootPromptMessagesJson: [Buffer.from("rebuilt-checkpoint")] } } });
              fixture.bridge.push({ message: { case: "execServerMessage", value: { id: 2, execId: "rebuilt-read", message: { case: "readArgs", value: { path: "/second.txt" } } } } });
            } else {
              fixture.bridge.push(interaction("textDelta", { text: "rebuilt continuation" }));
              fixture.bridge.push(interaction("turnEnded"));
            }
          });
        } else if (message.message.case === "execClientMessage") {
          queueMicrotask(() => {
            fixture.bridge.push(interaction("textDelta", { text: "same-scope continuation" }));
            fixture.bridge.push(interaction("turnEnded"));
          });
        }
      };

      return fixture.bridge;
    });

    try {
      const port = await startProxy(async req => req.headers.authorization.slice(7));
      const url = `http://127.0.0.1:${port}/v1/chat/completions`;
      const origin = "review-origin-" + mode;
      const messages = [{ role: "system", content: "original instructions" }, { role: "user", content: "past request" }, { role: "assistant", content: "past answer" }, { role: "user", content: "read the fixture" }];
      const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
      const body = { pi_session_id: "review-http-" + mode, model: "review-model", messages, tools, stream: true };
      const post = (token, request) => fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, body: JSON.stringify(request) });
      const first = await bounded("HTTP tool pause", post(origin, body).then(response => response.text()));
      const packets = first.split("\n").flatMap(line => line.startsWith("data: {") ? [JSON.parse(line.slice(6))] : []);
      const calls = packets.flatMap(packet => packet.choices).flatMap(choice => choice.delta.tool_calls || []);
      const call = calls[0];
      assert.ok(call, "the original account must actually enter a native tool pause");
      const selectedToken = ["account", "rebuild-resume", "rebuild-prefix-result"].includes(mode) ? "review-other-account" : origin;
      const selectedModel = mode === "model" ? "review-other-model" : body.model;
      const continuation = { ...body, model: selectedModel, stream: mode !== "nonstream", messages: [...messages, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "review result" }] };

      if (mode === "rebuild-prefix-result") continuation.messages[4] = { ...continuation.messages[4], tool_calls: calls };

      if (mode === "system") continuation.messages[0] = { role: "system", content: "updated instructions" };

      if (mode === "history") continuation.messages[2] = { role: "assistant", content: "edited past answer" };

      if (mode === "user") continuation.messages[3] = { role: "user", content: "a different current request" };

      if (mode === "rewind") continuation.messages.splice(1, 2);

      if (mode === "tools") continuation.tools = [];

      if (mode === "same") continuation.tools = [{ function: { parameters: { properties: { path: { type: "string" } }, type: "object" }, name: "read" }, type: "function" }];

      if (mode === "new-turn") continuation.messages.splice(4, 0, { role: "user", content: "new unrelated request" });
      const response = await bounded("HTTP continuation", post(selectedToken, continuation));
      const text = await bounded("HTTP continuation body", response.text());
      assert.equal(response.status, 200);
      assert.equal(runs.at(-1).token, selectedToken, "reported rotation must switch the authenticated Run, not just its SSE label");
      assert.equal(runs.at(-1).model, selectedModel, "changing the model must not reuse the old Run");

      if (["rebuild-resume", "rebuild-prefix-result"].includes(mode)) {
        const packets = text.split("\n").flatMap(line => line.startsWith("data: {") ? [JSON.parse(line.slice(6))] : []);
        const nextCall = packets.flatMap(packet => packet.choices).flatMap(choice => choice.delta.tool_calls || [])[0];

        assert.ok(nextCall, "the replacement account must enter its own native tool pause");
        const resumedMessages = [...continuation.messages, { role: "assistant", content: null, tool_calls: [nextCall] }, { role: "tool", tool_call_id: nextCall.id, content: "second result" }];

        const pendingOwnerId = runs.at(-1).id;

        if (mode === "rebuild-prefix-result") {
          assert.equal(calls.length, 2);
          resumedMessages.splice(continuation.messages.length, 0, { role: "tool", tool_call_id: calls[1].id, content: "late result from the abandoned Run" });
        }

        const resumed = await bounded("rebuilt native resume", post(selectedToken, { ...continuation, messages: resumedMessages }).then(response => response.text()));

        if (mode === "rebuild-prefix-result") {
          assert.match(resumed, /rebuilt continuation/, "results from abandoned Runs must enter rebuilt context, not a different native exec map");
          assert.notEqual(runs.at(-1).id, pendingOwnerId);

          return;
        }

        assert.match(resumed, /same-scope continuation/, "rebuilt turns must retain earlier Pi steps without starting another Run");
        const ownerId = runs.at(-1).id;
        const next = await bounded("completed rebuilt turn", post(selectedToken, { ...continuation, messages: [...resumedMessages, { role: "assistant", content: "same-scope continuation" }, { role: "user", content: "next turn" }] }).then(response => response.text()));

        assert.match(next, /rebuilt continuation/);
        assert.equal(runs.at(-1).id, ownerId, "a completed rebuilt turn must remain reusable");
        assert.equal(Buffer.from(runs.at(-1).roots[0]).toString(), "rebuilt-checkpoint");

        return;
      }

      if (mode === "nonstream") {
        assert.match(response.headers.get("content-type"), /application\/json/);
        assert.equal(JSON.parse(text).choices[0].message.content, "rebuilt continuation");
      } else assert.match(text, ["same", "completed-edit", "completed-same"].includes(mode) ? /same-scope continuation/ : /rebuilt continuation/);

      if (["completed-edit", "completed-same"].includes(mode)) {
        const next = { ...body, messages: [...continuation.messages, { role: "assistant", content: mode === "completed-edit" ? "edited final answer" : "same-scope continuation" }, { role: "user", content: "next request" }] };

        if (mode === "completed-same") {
          next.messages[4] = { ...next.messages[4], tool_calls: [{ ...call, id: "host-normalized-call" }] };
          next.messages[5] = { ...next.messages[5], tool_call_id: "host-normalized-call" };
        }

        const completed = await bounded("HTTP next turn", post(origin, next).then(response => response.text()));

        assert.match(completed, /rebuilt continuation/);

        if (mode === "completed-same") {
          assert.equal(runs.at(-1).id, runs[0].id, "unmodified completed turns must keep their conversation/checkpoint");
          assert.equal(Buffer.from(runs.at(-1).roots[0]).toString(), "checkpoint-root");
        } else {
          assert.notEqual(runs.at(-1).id, runs[0].id, "rewriting the last completed answer must mint a fresh conversation");
          assert.notEqual(Buffer.from(runs.at(-1).roots[0]).toString(), "checkpoint-root", "the stale checkpoint must not cross the Run boundary");
        }
      } else if (!["same", "nonstream"].includes(mode)) {
        assert.notEqual(runs.at(-1).id, runs[0].id, "changed context must rebuild, not merely relabel the old Run");
      }
    } finally {
      stopProxy();
      setBridgeFactoryForTests();
    }
  });
});

test("Cursor unary bridge drains stdout before completion and settles a spawn failure", async () => {
  for (const mode of ["drain", "spawn-error"]) {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.kill = () => {};

    setBridgeFactoryForTests(() => createBridgeHandle(proc));

    try {
      const pending = callCursorUnaryRpc({ accessToken: "review-key", rpcPath: "fixture", requestBody: Buffer.alloc(0), timeoutMs: 25 });

      if (mode === "drain") {
        proc.emit("exit", 0);
        proc.stdout.write(lpEncode(Buffer.from("complete reply")));
        proc.emit("close", 0);
        const result = await bounded("stdout drained", pending);
        assert.equal(result.body.toString(), "complete reply");
        assert.equal(result.exitCode, 0);
      } else {
        proc.emit("error", new Error("fixture spawn unavailable"));
        proc.emit("close", -2);
        const result = await bounded("spawn close", pending);
        assert.equal(result.exitCode, -2);
        assert.equal(result.timedOut, false);
      }
    } finally {
      setBridgeFactoryForTests();
    }
  }
});

test("Cursor failed Runs return errors rather than successful partial answers", async t => {
  for (const code of [0, 1, "terminal"]) for (const stream of [true, false]) await t.test((stream ? "SSE" : "JSON") + " exit " + code, async () => {
    const bridges = [];

    setBridgeFactoryForTests(() => {
      const fixture = streamFixture();
      fixture.bridge.write = bytes => {
        const message = fromBinary(AgentClientMessageSchema, Buffer.from(bytes).subarray(5));

        if (message.message.case !== "runRequest") return;
        queueMicrotask(() => {
          fixture.bridge.push({ message: { case: "conversationCheckpointUpdate", value: {} } });
          fixture.bridge.push(interaction("textDelta", { text: "partial only" }));

          if (code === "terminal") fixture.bridge.endStream({});
          else fixture.bridge.close(code);
        });
      };

      bridges.push(fixture.bridge);

      return fixture.bridge;
    });

    try {
      const port = await startProxy(async () => "review-failed-key");
      const response = await bounded("failed Run", fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, body: JSON.stringify({ pi_session_id: "review-failed", model: "fixture", messages: [{ role: "user", content: "fixture" }], stream }) }));
      const text = await bounded("failed Run body", response.text());

      if (stream) {
        const packets = text.split("\n").flatMap(line => line.startsWith("data: {") ? [JSON.parse(line.slice(6))] : []);
        const error = packets.find(packet => packet.error)?.error;
        assert.equal(error?.type, "upstream_error");
        assert.equal(error.message, (code === 1 ? "Bridge connection lost" : "Cursor Run ended before turnEnded") + " (workspace and session state unchanged)");
        assert.ok(!packets.some(packet => packet.choices?.[0]?.finish_reason === "stop"));
      } else {
        assert.equal(response.status, 502);
        assert.equal(JSON.parse(text).error.type, "upstream_error");
        assert.match(JSON.parse(text).error.message, /workspace and session state unchanged/, "non-streaming terminal errors carry the same reassurance");
      }

      assert.equal(conversationStates.has(deriveConversationKeyFromSessionId("review-failed")), false, "failed Runs cannot supply a reusable checkpoint");
    } finally {
      for (const bridge of bridges) bridge.close();
      stopProxy();
      setBridgeFactoryForTests();
    }
  });
});

test("Cursor non-streaming stalls are bounded and kill the abandoned Run", async () => {
  const previous = process.env.PI_CURSOR_TRANSPORT_STALL_MS;
  process.env.PI_CURSOR_TRANSPORT_STALL_MS = "15";
  let bridge;
  setBridgeFactoryForTests(() => {
    bridge = streamFixture().bridge;

    return bridge;
  });

  try {
    const port = await startProxy(async () => "review-stalled-key");
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", signal: AbortSignal.timeout(250), headers: { "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, body: JSON.stringify({ pi_session_id: "review-stalled", model: "fixture", messages: [{ role: "user", content: "fixture" }], stream: false }) });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /stalled.*workspace and session state unchanged/, "stall errors reassure against workspace-loss confabulation");
    assert.equal(bridge.alive, false);
    assert.equal(conversationStates.has(deriveConversationKeyFromSessionId("review-stalled")), false);
  } finally {
    bridge?.close();
    stopProxy();
    setBridgeFactoryForTests();

    if (previous === undefined) delete process.env.PI_CURSOR_TRANSPORT_STALL_MS;
    else process.env.PI_CURSOR_TRANSPORT_STALL_MS = previous;
  }
});

test("Cursor intentional bridge termination after turnEnded retains the successful checkpoint", async () => {
  const fixture = streamFixture();
  const convKey = "review-successful-cancel";
  const stored = { blobStore: new Map() };
  conversationStates.set(convKey, stored);
  fixture.bridge.destroy = () => fixture.bridge.close(1);

  try {
    writeSSEStreamForTests({ bridge: fixture.bridge, modelId: "fixture", bridgeKey: "review-successful-cancel", convKey, completedTurns: [], currentTurn: { userText: "fixture", steps: [] }, req: fixture.req, res: fixture.res });
    fixture.bridge.push({ message: { case: "conversationCheckpointUpdate", value: {} } });
    fixture.bridge.push(interaction("turnEnded"));
    await fixture.done;
    assert.ok(stored.checkpoint instanceof Uint8Array);
    assert.equal(conversationStates.get(convKey), stored, "a successful Run killed intentionally is not an upstream failure");
    assert.ok(fixture.packets().some(packet => packet.choices[0]?.finish_reason === "stop"));
  } finally {
    stopProxy();
  }
});

test("Cursor cancellation cannot reuse a partial checkpoint or overwrite a replacement Run", async t => {
  for (const stream of [true, false]) await t.test(stream ? "SSE" : "JSON", async () => {
    const fixture = streamFixture();
    const convKey = "restart-cancellation-" + stream;
    const bridgeKey = convKey;
    const blobs = new Map([["old-run-blob", new Uint8Array([1])]]);
    const stored = { blobStore: blobs, checkpoint: null };
    conversationStates.set(convKey, stored);
    const oldId = deterministicConversationId(convKey);
    const currentTurn = { userText: "cancel this run", steps: [] };
    let collecting;

    try {
      if (stream) {
        writeSSEStreamForTests({ bridge: fixture.bridge, bridgeKey, convKey, modelId: "fixture", blobStore: blobs, completedTurns: [], currentTurn, req: fixture.req, res: fixture.res });
      } else {
        setBridgeFactoryForTests(() => fixture.bridge);
        collecting = handleNonStreamingResponse({ requestBytes: new Uint8Array(), blobStore: blobs, mcpTools: [] }, "fixture", "fixture", convKey, [], currentTurn, fixture.req, fixture.res);
      }

      fixture.bridge.push({ message: { case: "conversationCheckpointUpdate", value: {} } });
      assert.ok(stored.checkpoint instanceof Uint8Array, "test must reach real buffered-checkpoint path");
      fixture.req.emit("close");
      const retainedAfterCancel = conversationStates.has(convKey);
      const nextId = deterministicConversationId(convKey);
      const replacement = { blobStore: new Map(), checkpoint: null, lastAccessMs: 0 };
      conversationStates.set(convKey, replacement);
      fixture.bridge.push({ message: { case: "conversationCheckpointUpdate", value: {} } });
      fixture.bridge.close(0);

      if (collecting) await bounded("cancelled JSON collector", collecting);
      assert.equal(retainedAfterCancel, false, "Escape discards a checkpoint that includes an incomplete turn");
      assert.notEqual(nextId, oldId, "the next Run must not rejoin the abandoned server conversation");
      assert.equal(replacement.checkpoint, null, "late cancelled stdout cannot publish into the new Run");
      assert.equal(replacement.blobStore.size, 0);
      assert.equal(replacement.lastAccessMs, 0);
    } finally {
      fixture.bridge.close();

      if (collecting) await collecting;
      stopProxy();
      setBridgeFactoryForTests();
    }
  });
});

test("obsolete bridge cleanup cannot erase a newer paused Run at the same session key", async () => {
  const old = streamFixture();
  const replacement = streamFixture();
  const bridgeKey = "restart-cleanup-ownership";
  const currentTurn = { userText: "new Run", steps: [] };

  try {
    writeSSEStreamForTests({ bridge: replacement.bridge, bridgeKey, convKey: bridgeKey, modelId: "fixture", completedTurns: [], currentTurn, req: replacement.req, res: replacement.res, mcpTools: [{ name: "read" }] });
    replacement.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: "new-run-read", message: { case: "readArgs", value: { path: "/fixture.txt" } } } } });
    await bounded("replacement tool pause", replacement.done);
    cleanupBridge(old.bridge, undefined, bridgeKey);
    const active = activeBridges.get(bridgeKey);
    assert.equal(active?.bridge, replacement.bridge, "cleanup owns the bridge instance, not every bridge that later uses its key");
    const resumed = streamFixture();
    replacement.bridge.write = bytes => {
      const reply = fromBinary(AgentClientMessageSchema, Buffer.from(bytes).subarray(5));

      if (reply.message.case === "execClientMessage") {
        replacement.bridge.push(interaction("textDelta", { text: "new Run survived" }));
        replacement.bridge.push(interaction("turnEnded"));
      }
    };

    const call = replacement.packets().flatMap(packet => packet.choices).flatMap(choice => choice.delta.tool_calls || [])[0];
    resumeCursorToolResultsForTests(active, [{ toolCallId: call.id, content: "fixture result" }], resumed.req, resumed.res, { modelId: "fixture", bridgeKey, convKey: bridgeKey, currentTurn });
    await bounded("replacement resumed", resumed.done);
    assert.match(resumed.packets().map(packet => packet.choices[0]?.delta.content || "").join(""), /new Run survived/);
  } finally {
    old.bridge.close();
    replacement.bridge.close();
    stopProxy();
  }
});

test("cancelled checkpoint commits cannot merge blobs or refresh a session", () => {
  const convKey = "restart-checkpoint-guard";
  const stored = { blobStore: new Map(), checkpoint: null, lastAccessMs: 0 };
  conversationStates.set(convKey, stored);

  try {
    commitConversationCheckpoint(convKey, new Map([["abandoned", new Uint8Array([1])]]), new Uint8Array(), false, "test");
    assert.equal(stored.blobStore.size, 0);
    assert.equal(stored.lastAccessMs, 0);
    assert.equal(stored.checkpoint, null);
  } finally {
    stopProxy();
  }
});

test("a paused Run failure invalidates its checkpoint without writing to the closed SSE", async t => {
  for (const terminalError of [true, false, "terminal"]) await t.test(terminalError === true ? "terminal error" : terminalError === false ? "clean premature close" : "clean terminal frame", async () => {
    const fixture = streamFixture();
    const convKey = "restart-paused-failure";
    const blobStore = new Map();
    conversationStates.set(convKey, { blobStore, checkpoint: null });
    const before = deterministicConversationId(convKey);

    try {
      writeSSEStreamForTests({ bridge: fixture.bridge, bridgeKey: convKey, convKey, blobStore, modelId: "fixture", completedTurns: [], currentTurn: { userText: "fixture", steps: [] }, req: fixture.req, res: fixture.res, mcpTools: [{ name: "read" }] });
      fixture.bridge.push({ message: { case: "conversationCheckpointUpdate", value: {} } });
      fixture.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: "paused-read", message: { case: "readArgs", value: { path: "/fixture.txt" } } } } });
      await bounded("failed tool pause", fixture.done);
      assert.ok(activeBridges.has(convKey));
      fixture.res.write = () => { throw new Error("cannot write to the completed SSE"); };

      if (terminalError === true) fixture.bridge.endStream({ error: { code: "resource_exhausted", message: "fixture quota exhausted" } });

      if (terminalError === "terminal") fixture.bridge.endStream({});
      else fixture.bridge.close(0);
      assert.equal(conversationStates.has(convKey), false, "a terminal upstream error cannot leave a pending-tools checkpoint reusable");
      assert.equal(activeBridges.has(convKey), false);
      assert.notEqual(deterministicConversationId(convKey), before);
    } finally {
      fixture.bridge.close();
      stopProxy();
    }
  });
});

test("settled JSON ignores late terminal frames caused by intentional bridge cancellation", async () => {
  const fixture = streamFixture();
  const convKey = "restart-settled-json";
  const blobStore = new Map();
  const stored = { blobStore, checkpoint: null };
  conversationStates.set(convKey, stored);
  setBridgeFactoryForTests(() => fixture.bridge);

  try {
    const collecting = handleNonStreamingResponse({ requestBytes: new Uint8Array(), blobStore, mcpTools: [] }, "fixture", "fixture", convKey, [], { userText: "fixture", steps: [] }, fixture.req, fixture.res);
    fixture.bridge.push({ message: { case: "conversationCheckpointUpdate", value: {} } });
    fixture.bridge.push(interaction("textDelta", { text: "complete answer" }));
    fixture.bridge.push(interaction("turnEnded"));
    await bounded("completed JSON", collecting);
    fixture.bridge.endStream({ error: { code: "cancelled", message: "intentional cancellation" } });
    assert.equal(conversationStates.get(convKey), stored, "a settled collector cannot erase the completed checkpoint");
    assert.ok(stored.checkpoint instanceof Uint8Array);
  } finally {
    fixture.bridge.close();
    stopProxy();
    setBridgeFactoryForTests();
  }
});

test("superseded collectors cannot commit old blobs when their child closes successfully", async t => {
  for (const stream of [true, false]) await t.test(stream ? "SSE" : "JSON", async () => {
    const fixture = streamFixture();
    const convKey = "restart-superseded-" + stream;
    const blobStore = new Map([["old-run", new Uint8Array([1])]]);
    conversationStates.set(convKey, { blobStore, checkpoint: null });
    let collecting;

    try {
      const turn = { userText: "old run", steps: [] };

      if (stream) {
        writeSSEStreamForTests({ bridge: fixture.bridge, bridgeKey: convKey, convKey, blobStore, modelId: "fixture", completedTurns: [], currentTurn: turn, req: fixture.req, res: fixture.res });
      } else {
        setBridgeFactoryForTests(() => fixture.bridge);
        collecting = handleNonStreamingResponse({ requestBytes: new Uint8Array(), blobStore, mcpTools: [] }, "fixture", "fixture", convKey, [], turn, fixture.req, fixture.res);
      }

      fixture.bridge.push({ message: { case: "conversationCheckpointUpdate", value: {} } });
      const replacement = { blobStore: new Map(), checkpoint: null, lastAccessMs: 0 };
      conversationStates.set(convKey, replacement);
      fixture.bridge.close(0);

      if (collecting) await collecting;
      assert.equal(replacement.blobStore.size, 0, "successful exit does not grant ownership of a replacement conversation");
      assert.equal(replacement.checkpoint, null);
      assert.equal(replacement.lastAccessMs, 0);
    } finally {
      fixture.bridge.close();

      if (collecting) await collecting;
      stopProxy();
      setBridgeFactoryForTests();
    }
  });
});

test("Cursor shutdown releases in-flight, paused and unary children without awaiting network deadlines", async () => {
  const server = http2.createServer();
  const sessions = new Set();
  const streams = [];
  const requestHeaders = [];
  server.on("session", session => sessions.add(session));
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    streams.push(stream);
    requestHeaders.push(headers);
    stream.respond({ ":status": 200 });
  });
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  const url = `http://127.0.0.1:${server.address().port}`;
  const originalFactory = bridgeFactory;
  const children = [];
  const closed = [];
  setBridgeFactoryForTests(options => {
    const bridge = originalFactory({ ...options, url });
    children.push(bridge);
    closed.push(once(bridge.proc, "close"));

    return bridge;
  });
  const live = streamFixture();
  const paused = streamFixture();
  const handlers = new Map();
  registerSessionLifecycleCleanup({ on: (name, handler) => handlers.set(name, handler) });
  const sessionId = "shutdown-current-session";
  const convKey = deriveConversationKeyFromSessionId(sessionId);
  let unary;

  try {
    const unaryArrived = once(server, "stream");
    unary = callCursorUnaryRpc({ accessToken: "fixture-local-only", rpcPath: "/fixture/catalog", requestBody: Buffer.from([1]), timeoutMs: 60000 });
    await bounded("local unary request", unaryArrived);
    const runArrived = once(server, "stream");
    const blobs = new Map();
    conversationStates.set(convKey, { blobStore: blobs, checkpoint: null });
    handleStreamingResponse({ requestBytes: new Uint8Array(), blobStore: blobs, mcpTools: [] }, "fixture-local-only", "fixture", sessionId, convKey, [], { userText: "in-flight fixture", steps: [] }, live.req, live.res);
    await bounded("local streaming request", runArrived);
    const pausedArrived = once(server, "stream");
    const pausedKey = "other-session-paused-run";
    handleStreamingResponse({ requestBytes: new Uint8Array(), blobStore: new Map(), mcpTools: [{ name: "read" }] }, "fixture-local-only", "fixture", pausedKey, pausedKey, [], { userText: "paused fixture", steps: [] }, paused.req, paused.res);
    await bounded("local paused request", pausedArrived);
    const message = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message: { case: "execServerMessage", value: { id: 1, execId: "local-read", message: { case: "readArgs", value: { path: "/fixture.txt" } } } } }));
    const frame = Buffer.alloc(message.length + 5);
    frame.writeUInt32BE(message.length, 1);
    frame.set(message, 5);
    streams[2].write(frame);
    await bounded("local tool pause", paused.done);
    assert.ok(activeBridges.has(pausedKey));
    const port = await startProxy(async () => "fixture-local-only");
    const started = performance.now();
    await handlers.get("session_shutdown")({ reason: "quit" }, { sessionManager: { getSessionId: () => sessionId } });
    await bounded("shutdown child closure", Promise.all(closed), 1000);
    await unary;
    assert.ok(performance.now() - started < 1000, "rotator teardown must not wait for the 60s fixture RPC deadline");
    assert.equal(getProxyPort(), undefined);
    assert.equal(activeBridges.size, 0);
    assert.equal(conversationStates.size, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, signal: AbortSignal.timeout(250) }));
    assert.ok(children.every(bridge => !bridge.alive));
    assert.ok(requestHeaders.every(headers => headers["user-agent"] === "OpenAI File Downloader, XaiImageApiFetch/1.0"), "unary and streaming HTTP2 requests carry the required agent identity");
  } finally {
    for (const bridge of children) bridge.destroy();
    await Promise.all(closed);

    if (unary) await unary;

    for (const session of sessions) session.destroy();
    await new Promise(resolve => server.close(resolve));
    stopProxy();
    setBridgeFactoryForTests();
  }
});

test("session replacement keeps the shared Cursor proxy so numbered accounts keep their loopback port", async () => {
  const handlers = new Map();
  registerSessionLifecycleCleanup({ on: (name, handler) => handlers.set(name, handler) });
  const session = { sessionManager: { getSessionId: () => "replacement-session" } };

  try {
    const port = await startProxy(async () => "fixture-local-only");

    for (const reason of ["new", "resume", "fork"]) {
      await handlers.get("session_shutdown")({ reason }, session);
      assert.equal(getProxyPort(), port, reason + " is a session replacement, not process teardown");
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, signal: AbortSignal.timeout(250) });
      assert.equal(response.status, 200, reason + " must not leave Cursor providers pointing at a closed loopback");
    }

    await handlers.get("session_shutdown")({ reason: "quit" }, session);
    assert.equal(getProxyPort(), undefined);
  } finally {
    stopProxy();
  }
});

test("Cursor restart reconnects every account to the restarted proxy rather than a cached dead port", async () => {
  try {
    const first = await ensureCursorProxy(async () => "fixture-before");
    assert.equal(getProxyPort(), first);
    stopProxy();
    const ports = await Promise.all([ensureCursorProxy(async () => "fixture-after"), ensureCursorProxy(async () => "fixture-after")]);
    assert.equal(getProxyPort(), ports[0]);
    assert.equal(ports[0], ports[1]);
    const response = await fetch(`http://127.0.0.1:${ports[0]}/v1/models`, { headers: { "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, signal: AbortSignal.timeout(250) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { object: "list", data: [] });
  } finally {
    stopProxy();
  }
});

test("concurrent proxy starts share one live listener", async () => {
  try {
    let ports;
    await assert.doesNotReject(async () => { ports = await Promise.all([startProxy(async () => "fixture-one"), startProxy(async () => "fixture-two")]); });
    assert.equal(ports[0], ports[1], "no orphan listener is created by overlapping provider preparation");
    assert.equal(getProxyPort(), ports[0]);
  } finally {
    stopProxy();
  }
});

test("proxy bind errors reject promptly and do not poison the next startup", async () => {
  const originalCreate = http.createServer;
  http.createServer = (...args) => {
    const server = originalCreate(...args);
    server.listen = () => {
      queueMicrotask(() => server.emit("error", Object.assign(new Error("fixture bind denied"), { code: "EACCES" })));

      return server;
    };

    return server;
  };

  syncBuiltinESMExports();

  try {
    await assert.rejects(bounded("failed bind", ensureCursorProxy(async () => "fixture-key"), 250), /fixture bind denied/);
  } finally {
    http.createServer = originalCreate;
    syncBuiltinESMExports();
    stopProxy();
  }

  try {
    const port = await ensureCursorProxy(async () => "fixture-key");
    assert.equal(getProxyPort(), port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, signal: AbortSignal.timeout(250) });
    assert.equal(response.status, 200);
  } finally {
    stopProxy();
  }
});

test("Cursor unary deadline settles even when child termination never produces close", async () => {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.kill = () => false;
  setBridgeFactoryForTests(() => createBridgeHandle(proc));

  try {
    const result = await bounded("unary deadline", callCursorUnaryRpc({ accessToken: "fixture", rpcPath: "/fixture", requestBody: Buffer.alloc(0), timeoutMs: 15 }), 250);
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.body.length, 0);
  } finally {
    proc.emit("close", 1);
    setBridgeFactoryForTests();
  }
});

test("proxy stop during bind rejects old preparation and does not close its replacement", async () => {
  const pending = startProxy(async () => "fixture-old");
  const cancelled = assert.rejects(pending, /stopped during startup/);
  stopProxy();
  await bounded("cancelled startup", cancelled, 250);

  try {
    const port = await startProxy(async () => "fixture-new");
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, signal: AbortSignal.timeout(250) });
    assert.equal(response.status, 200);
    assert.equal(getProxyPort(), port);
  } finally {
    stopProxy();
  }
});

test("proxy shutdown closes incomplete HTTP bodies rather than waiting for the client", async () => {
  const port = await startProxy(async () => "fixture-key");
  const request = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers: { expect: "100-continue", "content-length": "1000", "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" } });
  request.on("error", () => {});

  try {
    const accepted = once(request, "continue");
    request.flushHeaders();
    await bounded("partial body accepted", accepted, 1000);
    request.write("{");
    const closed = new Promise(resolve => request.socket.once("close", resolve));
    stopProxy();
    await bounded("partial body closed by shutdown", closed, 250);
    assert.equal(request.socket.destroyed, true);
  } finally {
    request.destroy();
    stopProxy();
  }
});

test("Cursor OAuth cancellation interrupts polling backoff and in-flight refresh", async () => {
  const originalFetch = globalThis.fetch;
  const request = new AbortController();
  let release;
  const started = new Promise(resolve => { release = resolve; });
  globalThis.fetch = (_url, options = {}) => new Promise((resolve, reject) => {
    release();
    const cancel = () => reject(options.signal?.reason || new Error("fixture cancelled"));
    options.signal?.addEventListener("abort", cancel, { once: true });
    request.signal.addEventListener("abort", cancel, { once: true });
  });
  let refreshing;
  let polling;

  try {
    const loginAbort = new AbortController();
    polling = pollCursorAuth("fixture", "fixture", loginAbort.signal);
    const rejected = assert.rejects(polling, { name: "AbortError" });
    loginAbort.abort();
    await bounded("aborted polling backoff", rejected, 250);
    refreshing = refreshCursorToken("fixture", { signal: request.signal });
    const refreshRejected = assert.rejects(refreshing, { name: "AbortError" });
    await started;
    request.abort();
    await bounded("aborted refresh", refreshRejected, 250);
  } finally {
    request.abort();
    // Complete any pending first polling fetch so cleanup is bounded.
    globalThis.fetch = async () => new Response(JSON.stringify({ accessToken: "fixture", refreshToken: "fixture" }), { status: 200 });

    if (polling) await polling.catch(() => {});

    if (refreshing) await refreshing.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

test("Cursor refresh validates token responses and retains the refresh token when not rotated", async () => {
  const previous = globalThis.fetch;

  try {
    for (const body of [{}, { accessToken: "", refreshToken: "fixture" }, { accessToken: 42, refreshToken: "fixture" }, { accessToken: "new-access", refreshToken: "" }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      await assert.rejects(refreshCursorToken("previous-refresh"), /invalid tokens/);
    }

    globalThis.fetch = async () => new Response(JSON.stringify({ accessToken: "new-access" }), { status: 200 });
    const retained = await refreshCursorToken("previous-refresh");

    assert.equal(retained.access, "new-access");
    assert.equal(retained.refresh, "previous-refresh");
    globalThis.fetch = async () => new Response(JSON.stringify({ accessToken: "rotated-access", refreshToken: "rotated-refresh" }), { status: 200 });
    const rotated = await refreshCursorToken("previous-refresh");

    assert.equal(rotated.access, "rotated-access");
    assert.equal(rotated.refresh, "rotated-refresh");
  } finally {
    globalThis.fetch = previous;
  }
});

test("Cursor polling cannot accept a response cancelled while reading its body", async () => {
  const previous = globalThis.fetch;

  try {
    for (const body of [{}, { accessToken: "fixture-access", refreshToken: "fixture-refresh" }]) {
      const controller = new AbortController();
      globalThis.fetch = async () => ({ status: 200, ok: true, async json() {
        controller.abort();

        return body;
      } });
      await bounded("cancelled poll response", assert.rejects(pollCursorAuth("fixture", "fixture", controller.signal), { name: "AbortError" }), 2500);
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test("Cursor OAuth refresh deadline covers stalled response bodies and shutdown cancels native login", async () => {
  const originalFetch = globalThis.fetch;
  let rejectBody;
  globalThis.fetch = async (_url, options) => ({ ok: true, json: () => new Promise((resolve, reject) => {
    rejectBody = reject;
    options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }) });
  let refreshing;
  let login;
  const loginAbort = new AbortController();

  try {
    refreshing = refreshCursorToken("fixture", { requestTimeoutMs: 15 });
    const rejected = assert.rejects(refreshing, { name: "TimeoutError" });
    await bounded("bounded refresh body", rejected, 250);
    const pi = fakePi();
    const { registerCursorProvider } = await import("../lib/cursor/cursor-shared.js");
    registerCursorProvider(pi, "cursor", 1);
    registerSessionLifecycleCleanup(pi);
    login = pi.providers.get("cursor").oauth.login({ onAuth() {}, signal: loginAbort.signal });
    const cancelled = assert.rejects(login, { name: "AbortError" });
    await Promise.resolve();

    for (const handler of pi.handlers.get("session_shutdown")) handler({ reason: "quit" }, { sessionManager: { getSessionId: () => "fixture-auth-shutdown" } });
    await bounded("shutdown login", cancelled, 250);
  } finally {
    loginAbort.abort();

    if (login) await login.catch(() => {});
    rejectBody?.(new Error("fixture cleanup"));

    if (refreshing) await refreshing.catch(() => {});
    globalThis.fetch = originalFetch;
    stopProxy();
  }
});


for (const ending of ["disconnect", "shutdown and restart", "synchronous shutdown"]) test(`proxy ignores late credentials after ${ending}`, async () => {
  const f = streamFixture();
  let release;

  const credential = new Promise(resolve => { release = resolve; });
  let announce;

  const entered = new Promise(resolve => { announce = resolve; });
  let socketClosed;
  let client;

  setBridgeFactoryForTests(() => f.bridge);

  try {
    const port = await startProxy(req => {
      socketClosed = new Promise(resolve => { req.socket.once("close", resolve); });
      announce();

      return credential;
    });

    client = http.request({ hostname: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" } });
    client.on("error", () => {});
    client.end(JSON.stringify({ model: "fixture-model", pi_session_id: "late-auth-fixture", messages: [{ role: "user", content: "fixture request" }] }));
    await bounded("credential lookup entered", entered);

    if (ending === "disconnect") client.destroy();
    else stopProxy();

    if (ending === "synchronous shutdown") release("old-fixture-token");
    await bounded("old HTTP connection closed", socketClosed);

    if (ending === "shutdown and restart") await startProxy(() => "replacement-fixture-token");
    release("old-fixture-token");
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(Buffer.concat(f.sent).byteLength, 0, "a closed request must not send a new Cursor Run frame");
    assert.equal(conversationStates.has(deriveConversationKeyFromSessionId("late-auth-fixture")), false, "a closed request cannot resurrect cleared session state");
  } finally {
    release("old-fixture-token");
    client?.destroy();
    f.bridge.close();
    stopProxy();
    setBridgeFactoryForTests(undefined);
  }
});


test("proxy rejects malformed request targets without an unhandled host rejection", () => {
  const script = `
    import http from "node:http";
    import { startProxy, stopProxy } from "./lib/cursor/proxy.js";
    const port = await startProxy(() => "fixture-token");
    const reply = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, method: "GET", path: "//[", headers: { "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" } }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.end();
    });
    stopProxy();
    console.log(JSON.stringify(reply));
  `;

  // Keep source-loading hooks in the isolated host, including mutation preloads.
  const preloads = process.execArgv.filter((arg, index, args) => arg === "--import" || args[index - 1] === "--import" || arg.startsWith("--import="));
  const reply = JSON.parse(execFileSync(process.execPath, [...preloads, "--input-type=module", "-e", script], { cwd: realpathSync(new URL("..", import.meta.url)), encoding: "utf8", timeout: 3000 }));

  assert.equal(reply.status, 400);
  assert.equal(reply.body.error.type, "invalid_request_error");
});


test("Cursor provenance describes current shipped bytes in both artifact tables", () => {
  const provenance = JSON.parse(readFileSync(new URL("../lib/cursor/PROVENANCE.json", import.meta.url), "utf8"));

  const pins = [
    ...provenance.files.map(file => [new URL("../lib/" + file.destination, import.meta.url), file.shippedSha256]),
    ...provenance.shippedModules.map(file => [new URL("../lib/cursor/" + file.path, import.meta.url), file.sha256]),
  ];

  for (const [path, expected] of pins) {
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), expected, path.pathname);
  }
});


test("Connect reassembly preserves retained protobuf, reentrant order and fragmented terminal headers", () => {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  const bridge = createBridgeHandle(proc);
  const texts = [];
  const retained = [];
  const terminal = [];
  const encode = text => frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, interaction("textDelta", { text }))));
  const a = encode("a".repeat(512));
  const b = encode("b".repeat(64));
  const c = encode("reentrant");

  const parser = createConnectFrameParser(bytes => {
    retained.push(bytes);
    const text = fromBinary(AgentServerMessageSchema, bytes).message.value.message.value.text;
    texts.push(text);

    if (text === "b".repeat(64)) proc.stdout.emit("data", lpEncode(c));
  }, bytes => terminal.push(JSON.parse(bytes.toString("utf8"))));

  bridge.onData(parser);
  const first = lpEncode(Buffer.concat([a, b.subarray(0, 8)]));
  proc.stdout.emit("data", first.subarray(0, 2));
  proc.stdout.emit("data", first.subarray(2));
  proc.stdout.emit("data", lpEncode(b.subarray(8)));
  const end = frameConnectMessage(Buffer.from('{"fixture":"ended"}'), 2);

  for (const byte of end) proc.stdout.emit("data", lpEncode(Uint8Array.of(byte)));
  assert.deepEqual(texts, ["a".repeat(512), "b".repeat(64), "reentrant"]);
  assert.equal(fromBinary(AgentServerMessageSchema, retained[0]).message.value.message.value.text, "a".repeat(512), "later feeds must not overwrite retained payload bytes");
  assert.deepEqual(terminal, [{ fixture: "ended" }]);
});


test("overlapping HTTP Runs cannot publish an older checkpoint into the next turn", async t => {
  for (const stream of [true, false]) await t.test(stream ? "SSE" : "JSON", async () => {
    const fixtures = [];
    const runs = [];
    let announce;
    const started = () => new Promise(resolve => { announce = resolve; });
    setBridgeFactoryForTests(() => {
      const fixture = streamFixture();
      fixtures.push(fixture);
      fixture.bridge.write = bytes => {
        const message = fromBinary(AgentClientMessageSchema, bytes.subarray(5));

        if (message.message.case !== "runRequest") return;
        runs.push(message.message.value);
        announce();

        if (runs.length === 3) queueMicrotask(() => {
          fixture.bridge.push(interaction("textDelta", { text: "next turn" }));
          fixture.bridge.push(interaction("turnEnded"));
        });
      };

      return fixture.bridge;
    });

    try {
      const port = await startProxy(async () => "overlap-fixture-token");
      const url = `http://127.0.0.1:${port}/v1/chat/completions`;
      const body = { model: "fixture", pi_session_id: "overlap-fixture", messages: [{ role: "user", content: "same request" }], stream };
      const post = request => fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, body: JSON.stringify(request), signal: AbortSignal.timeout(5000) }).then(response => response.text());
      let ready = started();
      const older = post(body);

      await bounded("first overlapping Run", ready);
      ready = started();
      const newer = post(body);

      await bounded("second overlapping Run", ready);
      fixtures[1].bridge.push({ message: { case: "conversationCheckpointUpdate", value: { rootPromptMessagesJson: [Buffer.from("newer-checkpoint")] } } });
      fixtures[1].bridge.push(interaction("textDelta", { text: "newer answer" }));
      fixtures[1].bridge.push(interaction("turnEnded"));
      assert.match(await bounded("newer HTTP completion", newer), /newer answer/);
      fixtures[0].bridge.push({ message: { case: "conversationCheckpointUpdate", value: { rootPromptMessagesJson: [Buffer.from("older-checkpoint")] } } });
      fixtures[0].bridge.push(interaction("textDelta", { text: "older answer" }));
      fixtures[0].bridge.push(interaction("turnEnded"));
      fixtures[0].bridge.close(0);
      await bounded("older HTTP completion", older);
      ready = started();
      const next = post({ ...body, messages: [...body.messages, { role: "assistant", content: "newer answer" }, { role: "user", content: "next request" }] });

      await bounded("next Run after overlap", ready);
      assert.match(await bounded("next HTTP completion", next), /next turn/);
      assert.equal(Buffer.from(runs.at(-1).conversationState.rootPromptMessagesJson[0]).toString(), "newer-checkpoint", "the next wire request must use the latest owner's checkpoint");
    } finally {
      for (const fixture of fixtures) fixture.bridge.close();
      stopProxy();
      setBridgeFactoryForTests();
    }
  });
});

test("Cursor restoration never replaces a foreign numbered provider", async t => {
  for (const race of [false, true]) await t.test(race ? "foreign slot appears during setup" : "foreign slot already registered", async () => {
    const pi = fakePi();
    const foreign = { baseUrl: "https://custom.invalid/v1", models: [{ id: "custom-model" }] };
    const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-owner-"));
    const state = { ownedAliases: new Set(), savedModelProviders: {} };
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "cursor-account-2": { type: "oauth", access: "fixture-cursor-token" } }));

    if (!race) pi.providers.set("cursor-account-2", foreign);

    const registry = { getProvider(id) {
      if (race && id === "cursor") queueMicrotask(() => pi.providers.set("cursor-account-2", foreign));

      return pi.providers.get(id);
    } };

    const accounts = createCursorAccounts(pi, dir, state);

    try {
      await accounts.restore(registry).catch(error => assert.match(error.message, /owned|foreign|registered/));
      assert.equal(pi.providers.get("cursor-account-2"), foreign, "restoring Cursor credentials must preserve foreign protocol/model configuration");
      assert.equal(accounts.owns("cursor-account-2"), false);
      assert.equal(state.ownedAliases.has("cursor-account-2"), false);

      if (!race) assert.equal(pi.providers.has("cursor"), false, "known conflicts must be rejected before any registration");
      else {
        assert.equal(accounts.owns("cursor"), true, "partial setup tracks only the base registration that actually succeeded");
        pi.providers.delete("cursor-account-2");
        await accounts.restore({ getProvider: id => pi.providers.get(id) });
        assert.equal(accounts.owns("cursor-account-2"), true, "a failed queued setup must be retryable after the conflict is cleared");
        assert.equal(state.ownedAliases.has("cursor-account-2"), true);
      }
    } finally {
      stopProxy();
    }
  });
});


test("late Cursor catalog refresh cannot reclaim an alias replaced by a foreign provider", async () => {
  const pi = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-catalog-owner-"));
  const state = { ownedAliases: new Set(), savedModelProviders: { "cursor-account-2": { modelOverrides: { "saved-future-model": { name: "saved future" } } } } };
  const registry = { getProvider: id => pi.providers.get(id), getRegisteredProviderConfig: id => pi.providers.get(id) };
  const accounts = createCursorAccounts(pi, dir, state);
  const previousFetch = globalThis.fetch;
  writeFileSync(join(dir, "auth.json"), "{}");

  setBridgeFactoryForTests(() => {
    let data, close;
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, { models: [{ modelId: "refreshed-model", displayName: "refreshed" }] }));

    return { proc: { kill() {} }, write() {}, onData(fn) { data = fn; }, onClose(fn) { close = fn; }, end() { queueMicrotask(() => { data(body); close(0); }); } };
  });

  try {
    await accounts.prepare(["cursor-account-2"], registry);
    let owned = pi.providers.get("cursor-account-2");
    pi.providers.set("cursor-account-2", { ...owned });
    assert.equal(accounts.owns("cursor-account-2"), true, "SDK shallow-merged config copies remain owned");
    globalThis.fetch = async () => new Response(JSON.stringify({ accessToken: "fixture-new-access", refreshToken: "fixture-new-refresh" }), { status: 200 });
    await owned.oauth.refreshToken({ refresh: "fixture-old-refresh" });
    owned = pi.providers.get("cursor-account-2");
    assert.deepEqual(owned.models, [], "a discovered sibling stays hidden");
    assert.ok(pi.providers.get("cursor").models.some(model => model.id === "refreshed-model"), "legitimate owned catalogs still update the carrier union");
    const foreign = { ...owned, baseUrl: "https://custom.invalid/v1" };
    pi.providers.set("cursor-account-2", foreign);
    await owned.oauth.refreshToken({ refresh: "fixture-old-refresh" });
    assert.equal(pi.providers.get("cursor-account-2"), foreign, "a late catalog callback cannot overwrite the current foreign definition");
    assert.equal(accounts.owns("cursor-account-2"), false, "an earlier registration is not perpetual ownership");
    assert.equal(state.ownedAliases.has("cursor-account-2"), false);
    pi.providers.delete("cursor-account-2");
    await accounts.prepare(["cursor-account-2"], registry);
    assert.equal(accounts.owns("cursor-account-2"), true, "relinquished IDs can be prepared again after the foreign definition is removed");
    assert.deepEqual(pi.providers.get("cursor-account-2").models, [], "reclaimed siblings stay hidden");
    assert.ok(pi.providers.get("cursor").models.some(model => model.id === "saved-future-model"), "reclaimed definitions are primed from saved metadata again");
  } finally {
    globalThis.fetch = previousFetch;
    stopProxy();
    setBridgeFactoryForTests();
  }
});

test("saved Cursor overrides collapse stale effort variants instead of resurrecting ghost models", async () => {
  const pi = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-ghost-"));

  const state = { ownedAliases: new Set(), savedModelProviders: { "cursor-account-2": { modelOverrides: {
    "cursor-grok-4.6-high": { name: "Grok 4.6", contextWindow: 200000, maxTokens: 64000 },
    "cursor-grok-4.6-high-fast": { name: "Grok 4.6 Fast", contextWindow: 200000, maxTokens: 64000 },
    "cursor-migration-future": { name: "saved newer Cursor model", contextWindow: 200000, maxTokens: 32000 },
  } } } };

  const registry = { getProvider: id => pi.providers.get(id), getRegisteredProviderConfig: id => pi.providers.get(id) };
  const accounts = createCursorAccounts(pi, dir, state);
  writeFileSync(join(dir, "auth.json"), "{}");

  try {
    await accounts.prepare(["cursor-account-2"], registry);
    assert.deepEqual(pi.providers.get("cursor-account-2").models, [], "non-carrier siblings list nothing");
    const models = pi.providers.get("cursor").models;
    const ids = models.map(model => model.id);
    assert.ok(!ids.includes("cursor-grok-4.6-high"), "a stale raw effort id is not resurrected as a model");
    assert.ok(!ids.includes("cursor-grok-4.6-high-fast"), "a stale raw fast effort id is not resurrected as a model");
    assert.ok(ids.includes("cursor-grok-4.6"), "the collapsed base stays registered from the fallback catalog");
    assert.ok(ids.includes("cursor-grok-4.6-fast"), "the fast counterpart survives as one collapsed entry");
    assert.ok(ids.includes("cursor-migration-future"), "genuinely unknown ids are still preserved");
    assert.ok(models.find(model => model.id === "cursor-grok-4.6-fast").thinkingLevelMap, "the collapsed fast entry carries an effort map, not a frozen label");
  } finally {
    stopProxy();
  }
});

test("corrupt cursor override shapes never publish junk model ids", async () => {
  const pi = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-junk-"));

  const state = { ownedAliases: new Set(), savedModelProviders: {
    cursor: { modelOverrides: { "": { name: "blank" }, "  ": { name: "spaces" } } },
    "cursor-account-2": { modelOverrides: ["not-an-object"] },
  } };

  const registry = { getProvider: id => pi.providers.get(id), getRegisteredProviderConfig: id => pi.providers.get(id) };
  const accounts = createCursorAccounts(pi, dir, state);

  writeFileSync(join(dir, "auth.json"), "{}");

  try {
    await accounts.prepare(["cursor-account-2"], registry);
    const ids = pi.providers.get("cursor").models.map(model => model.id);
    assert.ok(!ids.includes(""), "blank override keys do not register");
    assert.ok(!ids.includes("  "), "whitespace override keys do not register");
    assert.ok(!ids.includes("0"), "non-object override sections do not register");
    assert.ok(ids.includes("cursor-grok-4.6"), "fallback coverage survives corrupt sections");
  } finally {
    stopProxy();
  }
});

test("cursor carrier sync promotes a base-less alias and demotes it when the base logs in", async () => {
  const pi = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-carrier-"));
  const state = { ownedAliases: new Set(), savedModelProviders: {} };
  const registry = { getProvider: id => pi.providers.get(id), getRegisteredProviderConfig: id => pi.providers.get(id) };
  const accounts = createCursorAccounts(pi, dir, state);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "cursor-account-2": { type: "oauth", access: token("slot2") } }));

  try {
    await accounts.prepare(["cursor-account-2"], registry);
    assert.ok(pi.providers.get("cursor-account-2").models.length > 0, "a base-less carrier alias lists the family catalog");
    assert.deepEqual(pi.providers.get("cursor").models, [], "the unconfigured base stays hidden");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ cursor: { type: "oauth", access: token("base") }, "cursor-account-2": { type: "oauth", access: token("slot2") } }));
    accounts.syncCarrier(["cursor", "cursor-account-2"], "cursor");
    assert.ok(pi.providers.get("cursor").models.length > 0, "the base carries once it logs in");
    assert.deepEqual(pi.providers.get("cursor-account-2").models, [], "the demoted alias hides");
    assert.ok(pi.providers.get("cursor").models.some(model => model.id === "cursor-grok-4.6"), "the carrier union keeps fallback coverage");
  } finally {
    stopProxy();
  }
});

test("cursor restore survives a throwing availability refresh and refreshes usable logins only", async () => {
  const pi = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-restore-refresh-"));
  const state = { ownedAliases: new Set(), savedModelProviders: {} };
  const refreshed = [];

  const registry = {
    getProvider: id => pi.providers.get(id),
    getRegisteredProviderConfig: id => pi.providers.get(id),
    refresh: async options => {
      refreshed.push(options.providers);

      throw new Error("host refresh down");
    },
  };

  const accounts = createCursorAccounts(pi, dir, state);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "cursor-account-2": { type: "oauth", access: token("slot2") }, "cursor-account-3": { type: "oauth" } }));

  try {
    await accounts.restore(registry);
    assert.ok(pi.providers.has("cursor-account-2"), "preparation lands before the failed refresh");
    assert.ok(pi.providers.has("cursor-account-3"), "malformed siblings still prepare");
    assert.deepEqual(refreshed, [["cursor-account-2"]], "refresh targets usable logins, never malformed entries");
  } finally {
    stopProxy();
  }
});

test("departed cursor slots leave the union; re-added slots restart from fallback", async () => {
  const pi = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-union-prune-"));
  const state = { ownedAliases: new Set(), savedModelProviders: {} };
  const registry = { getProvider: id => pi.providers.get(id), getRegisteredProviderConfig: id => pi.providers.get(id) };
  const accounts = createCursorAccounts(pi, dir, state);
  const previousFetch = globalThis.fetch;
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ cursor: { type: "oauth", access: token("base") }, "cursor-account-2": { type: "oauth", access: token("slot2") } }));
  const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, { models: [{ modelId: "slot2-unique-model", displayName: "Slot2 unique" }] }));
  setBridgeFactoryForTests(() => {
    let data, close;

    return { proc: { kill() {} }, write() {}, onData(fn) { data = fn; }, onClose(fn) { close = fn; }, end() { queueMicrotask(() => { data(body); close(0); }); } };
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ accessToken: token("new"), refreshToken: "new-refresh" }), { status: 200 });

  try {
    await accounts.prepare(["cursor", "cursor-account-2"], registry);
    await pi.providers.get("cursor-account-2").oauth.refreshToken({ refresh: "old-refresh" });
    assert.ok(pi.providers.get("cursor").models.some(model => model.id === "slot2-unique-model"), "sibling discovery joins the union");
    accounts.syncCarrier(["cursor"], "cursor");
    assert.ok(!pi.providers.get("cursor").models.some(model => model.id === "slot2-unique-model"), "departed slots leave the union");
    accounts.syncCarrier([], null);
    accounts.syncCarrier(["cursor", "cursor-account-2"], "cursor");
    assert.deepEqual(pi.providers.get("cursor-account-2").models, []);
    assert.ok(pi.providers.get("cursor").models.some(model => model.id === "cursor-grok-4.6"), "re-added slots restart from fallback coverage");
    assert.ok(!pi.providers.get("cursor").models.some(model => model.id === "slot2-unique-model"), "stale discovered ids do not linger");
  } finally {
    globalThis.fetch = previousFetch;
    stopProxy();
    setBridgeFactoryForTests();
  }
});

test("carrier sync never breaks rediscovery when a re-registration is rejected", async () => {
  const pi = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-sync-fail-"));
  const state = { ownedAliases: new Set(), savedModelProviders: {} };
  const registry = { getProvider: id => pi.providers.get(id), getRegisteredProviderConfig: id => pi.providers.get(id) };
  const accounts = createCursorAccounts(pi, dir, state);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "cursor-account-2": { type: "oauth", access: token("slot2") } }));

  try {
    await accounts.prepare(["cursor-account-2"], registry);
    const before = pi.providers.get("cursor-account-2").models.length;
    assert.ok(before > 0);
    pi.registerProvider = () => { throw new Error("host rejects re-registration"); };

    assert.doesNotThrow(() => accounts.syncCarrier(["cursor", "cursor-account-2"], "cursor"));
    assert.equal(pi.providers.get("cursor-account-2").models.length, before, "the working listing survives");
  } finally {
    stopProxy();
  }
});

test("removing a cursor slot forgets its union share immediately", async () => {
  const pi = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-forget-"));
  const state = { ownedAliases: new Set(), savedModelProviders: {} };
  const registry = { getProvider: id => pi.providers.get(id), getRegisteredProviderConfig: id => pi.providers.get(id) };
  const accounts = createCursorAccounts(pi, dir, state);
  const previousFetch = globalThis.fetch;
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ cursor: { type: "oauth", access: token("base") }, "cursor-account-2": { type: "oauth", access: token("slot2") } }));
  const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, { models: [{ modelId: "slot2-unique-model", displayName: "Slot2 unique" }] }));
  setBridgeFactoryForTests(() => {
    let data, close;

    return { proc: { kill() {} }, write() {}, onData(fn) { data = fn; }, onClose(fn) { close = fn; }, end() { queueMicrotask(() => { data(body); close(0); }); } };
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ accessToken: token("new"), refreshToken: "new-refresh" }), { status: 200 });

  try {
    await accounts.prepare(["cursor", "cursor-account-2"], registry);
    await pi.providers.get("cursor-account-2").oauth.refreshToken({ refresh: "old-refresh" });
    assert.ok(pi.providers.get("cursor").models.some(model => model.id === "slot2-unique-model"));
    accounts.forgetSlot("cursor-account-2");
    accounts.syncCarrier(["cursor", "cursor-account-2"], "cursor");
    assert.ok(!pi.providers.get("cursor").models.some(model => model.id === "slot2-unique-model"), "forgotten slots leave the union without waiting on rediscovery");
    assert.ok(pi.providers.get("cursor").models.some(model => model.id === "cursor-grok-4.6"), "fallback coverage remains");
  } finally {
    globalThis.fetch = previousFetch;
    stopProxy();
    setBridgeFactoryForTests();
  }
});

test("offline Cursor bootstrap preserves explicitly configured foreign endpoints without a registry", async t => {
  for (const id of ["cursor", "cursor-account-2"]) await t.test(id, async () => {
    const pi = fakePi();
    const foreign = { baseUrl: "https://custom.invalid/v1", apiKey: "fixture-custom-key", models: [{ id: "custom-model" }] };
    const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-bootstrap-"));
    const state = { ownedAliases: new Set(), savedModelProviders: { [id]: foreign } };
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "cursor-account-2": { type: "oauth", access: "fixture-cursor-token" } }));
    pi.providers.set(id, foreign);
    const accounts = createCursorAccounts(pi, dir, state);

    try {
      await accounts.restore();
      assert.equal(pi.providers.get(id), foreign, "before session_start, saved configuration must prevent takeover too");
      assert.equal(accounts.owns(id), false);
      assert.equal(state.ownedAliases.has(id), false);
    } finally {
      stopProxy();
    }
  });
});


test("queued native tools cannot outlive their conversation owner", async t => {
  for (const replacement of [false, true]) await t.test(replacement ? "replacement Run" : "forgotten conversation", async () => {
    const older = streamFixture();
    const newer = streamFixture();
    const key = "queued-tool-owner";
    const original = { blobStore: new Map(), checkpoint: null };
    const current = { blobStore: new Map(), checkpoint: null };
    const options = { modelId: "fixture", bridgeKey: key, convKey: key, completedTurns: [], mcpTools: [{ name: "read" }] };
    const exec = id => ({ message: { case: "execServerMessage", value: { id: 1, execId: id, message: { case: "readArgs", value: { path: "/" + id } } } } });
    conversationStates.set(key, original);

    try {
      writeSSEStreamForTests({ ...options, bridge: older.bridge, req: older.req, res: older.res, currentTurn: { userText: "older", steps: [] } });
      older.bridge.push(exec("obsolete-tool"));
      conversationStates.delete(key);

      if (replacement) {
        conversationStates.set(key, current);
        writeSSEStreamForTests({ ...options, bridge: newer.bridge, req: newer.req, res: newer.res, currentTurn: { userText: "newer", steps: [] } });
        newer.bridge.push(exec("current-tool"));
      }

      await bounded("obsolete coalesced response", older.done);
      const oldChoices = older.packets().flatMap(packet => packet.choices || []);

      assert.equal(oldChoices.some(choice => choice.delta.tool_calls?.length), false, "a delayed batch must not authorize tools from a superseded Run");
      assert.ok(older.packets().some(packet => packet.error?.type === "upstream_error" && /superseded/.test(packet.error.message)));
      assert.equal(older.bridge.alive, false);

      if (replacement) {
        await bounded("current coalesced response", newer.done);
        const calls = newer.packets().flatMap(packet => packet.choices).flatMap(choice => choice.delta.tool_calls || []);

        assert.equal(calls.length, 1);
        assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: "/current-tool" });
        assert.equal(activeBridges.get(key)?.bridge, newer.bridge);
        assert.equal(conversationStates.get(key), current, "obsolete cleanup must not discard the replacement");
      } else assert.equal(activeBridges.has(key), false);
    } finally {
      older.bridge.close();
      newer.bridge.close();
      stopProxy();
    }
  });
});


test("partial HTTP tool batches retain results and reusable multi-turn checkpoints", async t => {
  for (const mode of ["append remaining results", "append returned pending calls", "changed arguments", "changed name", "repeat completed call", "changed pending id"]) await t.test(mode, async () => {
    const runs = [];
    const replies = [];
    setBridgeFactoryForTests(() => {
      const f = streamFixture();
      f.bridge.write = bytes => {
        const { message } = fromBinary(AgentClientMessageSchema, bytes.subarray(5));

        if (message.case === "runRequest") {
          runs.push(message.value);
          queueMicrotask(() => {
            if (runs.length > 1) {
              f.bridge.push(interaction("textDelta", { text: "next answer" }));
              f.bridge.push(interaction("turnEnded"));

              return;
            }

            f.bridge.push({ message: { case: "conversationCheckpointUpdate", value: { rootPromptMessagesJson: [Buffer.from("batch-checkpoint")] } } });

            for (const id of [1, 2]) f.bridge.push({ message: { case: "execServerMessage", value: { id, execId: "batch-" + id, message: { case: "readArgs", value: { path: "/batch-" + id } } } } });
          });
        } else if (message.case === "execClientMessage") {
          replies.push(message.value);

          if (replies.length === 2) {
            f.bridge.push(interaction("textDelta", { text: "both results observed" }));
            f.bridge.push(interaction("turnEnded"));
          }
        }
      };

      return f.bridge;
    });

    try {
      const port = await startProxy(async () => "fixture-batch-token");
      const body = { model: "fixture", pi_session_id: "batch-fixture", stream: true, messages: [{ role: "user", content: "read both fixtures" }], tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }] };
      const post = messages => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, body: JSON.stringify({ ...body, messages }), signal: AbortSignal.timeout(5000) }).then(response => response.text());
      const callsIn = text => text.split("\n").flatMap(line => line.startsWith("data: {") ? JSON.parse(line.slice(6)).choices : []).flatMap(choice => choice.delta.tool_calls || []);
      const calls = callsIn(await post(body.messages));

      assert.equal(calls.length, 2);
      const messages = [...body.messages, { role: "assistant", content: null, tool_calls: calls }, { role: "tool", tool_call_id: calls[0].id, content: "first result" }];
      const waiting = callsIn(await post(messages));

      assert.deepEqual(waiting.map(call => call.id), [calls[1].id]);
      assert.equal(replies.length, 0, "partial batches must not prematurely finish native execs");

      if (mode === "changed pending id") {
        messages[1] = { ...messages[1], tool_calls: [calls[0], { ...calls[1], id: "different-pending-id" }] };
      } else if (mode !== "append remaining results") {
        let repeated = waiting[0];

        if (mode === "changed arguments") repeated = { ...repeated, function: { ...repeated.function, arguments: JSON.stringify({ path: "/different-file" }) } };

        if (mode === "changed name") repeated = { ...repeated, function: { ...repeated.function, name: "write" } };

        if (mode === "repeat completed call") repeated = calls[0];
        messages.push({ role: "assistant", content: null, tool_calls: [repeated] });
      }

      messages.push({ role: "tool", tool_call_id: mode === "changed pending id" ? "different-pending-id" : calls[1].id, content: "second result" });
      const completed = await post(messages);

      if (!["append remaining results", "append returned pending calls"].includes(mode)) {
        assert.match(completed, /next answer/);
        assert.equal(replies.length, 0, "changed calls must not deliver results to the old native Run");
        assert.notEqual(runs.at(-1).conversationId, runs[0].conversationId);

        return;
      }

      assert.match(completed, /both results observed/, "a repeated pending call is not a new execution or changed transcript");
      assert.deepEqual(replies.map(reply => [reply.execId, reply.message.value.result.value.output.value]), [["batch-1", "first result"], ["batch-2", "second result"]]);
      messages.push({ role: "assistant", content: "both results observed" }, { role: "user", content: "next user turn" });
      assert.match(await post(messages), /next answer/);
      messages.push({ role: "assistant", content: "next answer" }, { role: "user", content: "one more turn" });

      for (const message of messages) {
        for (const call of message.tool_calls || []) call.id = "normalized-" + call.id;

        if (message.tool_call_id) message.tool_call_id = "normalized-" + message.tool_call_id;
      }

      assert.match(await post(messages), /next answer/);
      assert.equal(runs.at(-1).conversationId, runs[0].conversationId, "normalizing older completed call IDs must preserve checkpoint identity");
      assert.equal(Buffer.from(runs.at(-1).conversationState.rootPromptMessagesJson[0]).toString(), "batch-checkpoint");
      messages.push({ role: "assistant", content: "next answer" }, { role: "user", content: "after history edit" });
      messages[2] = { ...messages[2], content: "edited earlier result" };
      assert.match(await post(messages), /next answer/);
      assert.notEqual(runs.at(-1).conversationId, runs[0].conversationId, "normalization must retain earlier result contents in transcript identity");
      assert.notEqual(Buffer.from(runs.at(-1).conversationState.rootPromptMessagesJson[0]).toString(), "batch-checkpoint");
    } finally {
      stopProxy();
      setBridgeFactoryForTests();
    }
  });
});


test("sweep: HTTP2 bridge drains backpressured stdout before successful exit", async () => {
  const server = http2.createServer();
  const sessions = new Set();
  const payload = Buffer.alloc(2 * 1024 * 1024, 97);
  let sent;
  const responseSent = new Promise(resolve => { sent = resolve; });
  server.on("session", session => sessions.add(session));
  server.on("stream", stream => {
    stream.on("error", () => {});
    stream.resume();
    stream.end(payload, sent);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bridge = bridgeFactory({ accessToken: "fixture-only", rpcPath: "/fixture", url: `http://127.0.0.1:${server.address().port}`, unary: true });
  const received = [];
  const closed = new Promise(resolve => { bridge.onClose(resolve); });
  bridge.onData(bytes => received.push(bytes));
  bridge.proc.stdout.pause();

  try {
    bridge.write(Buffer.from("fixture request"));
    bridge.end();
    await bounded("local HTTP2 response", responseSent, 5000);
    // Delay the consumer beyond the former fixed 100ms exit grace while stdout is backed up.
    await new Promise(resolve => setTimeout(resolve, 250));
    bridge.proc.stdout.resume();
    assert.equal(await bounded("bridge drain", closed, 5000), 0);
    const bytes = Buffer.concat(received);
    assert.equal(bytes.length, payload.length, "successful bridge completion cannot truncate buffered output");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(payload).digest("hex"));
  } finally {
    bridge.destroy();

    for (const session of sessions) session.destroy();

    await new Promise(resolve => server.close(resolve));
  }
});


test("sweep: folded fast Opus catalogs retain their declared premium estimate", () => {
  const models = processModels([{ id: "claude-4.6-opus-high-fast", name: "Opus High", contextWindow: 200000, maxTokens: 64000 }, { id: "claude-4.6-opus-high", name: "Opus High", contextWindow: 200000, maxTokens: 64000 }]).map(modelConfig);
  assert.equal(models.find(model => model.id.endsWith("-fast")).cost.input, 30, "fast Opus must not silently use the standard estimate of 5");
  assert.equal(models.find(model => !model.id.endsWith("-fast")).cost.input, 5);
});

test("sweep: thinking tag interpretation is invariant across whitespace fragment boundaries", () => {
  for (const tag of ["think", "thinking", "think_intent"]) {
    const text = `visible<${tag}   >private</${tag}   >tail`;

    for (let split = 0; split <= text.length; split++) {
      const filter = createThinkingTagFilter();
      const parts = [filter.process(text.slice(0, split)), filter.process(text.slice(split)), filter.flush()];
      assert.equal(parts.map(part => part.content).join(""), "visibletail", "fragmented " + tag + " at " + split + " must not leak hidden text");
      assert.equal(parts.map(part => part.reasoning).join(""), "private");
    }
  }
});

test("Cursor protobuf and MCP maps preserve special JSON keys end to end", async t => {
  const args = JSON.parse('{"__proto__":{"__proto__":"nested data","constructor":{"prototype":"still data"}},"constructor":"own constructor","prototype":[{"__proto__":7},false,null],"ordinary":"keep"}');
  const parameters = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"object"},"constructor":{"type":"string"},"prototype":{"type":"array"},"ordinary":{"type":"string"}}}');
  const tools = [{ type: "function", function: { name: "map_fixture", parameters } }];

  await t.test("protobuf maps and advertised schemas", () => {
    const encoded = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, toBinary(ValueSchema, fromJson(ValueSchema, value))]));
    const message = create(AgentServerMessageSchema, { message: { case: "execServerMessage", value: { id: 1, execId: "map-fixture", message: { case: "mcpArgs", value: { name: "map_fixture", args: encoded } } } } });
    const copied = message.message.value.message.value.args;
    assert.deepEqual(Object.keys(copied).sort(), Object.keys(args).sort(), "create must preserve map entries as own data");
    // Supply actual wire entries independently of create's map copying.
    message.message.value.message.value.args = encoded;
    const decoded = fromBinary(AgentServerMessageSchema, toBinary(AgentServerMessageSchema, message)).message.value.message.value.args;
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype, "wire keys cannot change map prototypes");
    assert.deepEqual(Object.fromEntries(Object.entries(decoded).map(([key, value]) => [key, toJson(ValueSchema, fromBinary(ValueSchema, value))])), args);
    const [definition] = buildMcpToolDefinitions(tools);
    assert.deepEqual(toJson(ValueSchema, fromBinary(ValueSchema, definition.inputSchema)), parameters, "tool parameter names survive WKT JSON and binary encoding");
  });

  await t.test("streamed native MCP arguments", async () => {
    const f = streamFixture();
    const key = "special-mcp-keys";
    const currentTurn = { userText: "fixture", steps: [] };
    conversationStates.set(key, { blobStore: new Map(), checkpoint: null });

    try {
      writeSSEStreamForTests({ bridge: f.bridge, req: f.req, res: f.res, modelId: "fixture", bridgeKey: key, convKey: key, completedTurns: [], currentTurn, mcpTools: buildMcpToolDefinitions(tools) });
      const encoded = Object.fromEntries(Object.entries(args).map(([name, value]) => [name, toBinary(ValueSchema, fromJson(ValueSchema, value))]));
      f.bridge.push({ message: { case: "execServerMessage", value: { id: 1, execId: "map-fixture", message: { case: "mcpArgs", value: { name: "map_fixture", providerIdentifier: "pi", toolCallId: "map-call", args: encoded } } } } });
      await bounded("native MCP map delivery", f.done);
      const calls = f.packets().flatMap(packet => packet.choices).flatMap(choice => choice.delta.tool_calls || []);
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(calls[0].function.arguments), args, "Pi receives every original argument, including nested special keys");
      assert.deepEqual(currentTurn.steps[0].arguments, args, "checkpoint ownership observes the same arguments as the tool");
    } finally {
      f.bridge.close();
      stopProxy();
    }
  });

  await t.test("serialized conversation history", () => {
    const payload = buildCursorRequest("fixture", "instructions", "next request", [{ userText: "earlier request", steps: [{ kind: "toolCall", toolCallId: "history-call", toolName: "map_fixture", arguments: args }] }], "fixture-conversation");
    const run = fromBinary(AgentClientMessageSchema, payload.requestBytes).message.value;
    const blob = id => payload.blobStore.get(Buffer.from(id).toString("hex"));
    const turn = fromBinary(ConversationTurnStructureSchema, blob(run.conversationState.turns[0])).turn.value;
    const step = fromBinary(ConversationStepSchema, blob(turn.steps[0]));
    const map = step.message.value.tool.value.args.args;
    assert.equal(Object.getPrototypeOf(map), Object.prototype);
    assert.deepEqual(Object.fromEntries(Object.entries(map).map(([name, value]) => [name, toJson(ValueSchema, fromBinary(ValueSchema, value))])), args, "history serialization cannot silently remove arguments");
  });
});

test("cursor rescue notes parse as user turns while other custom messages stay dropped", () => {
  const parsed = parseMessages([
    { role: "user", content: "do the thing" },
    { role: "custom", customType: "unrelated/contract", content: "must not leak into cursor turns" },
    { role: "custom", customType: "pi-rotator/rescue-note", content: "[pi-rotator] switched account; continue." },
  ]);

  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].userText, "do the thing");
  assert.equal(parsed.userText, "[pi-rotator] switched account; continue.");
  assert.ok(!JSON.stringify(parsed).includes("must not leak"));
});

test("cursor-minted dual tool ids round-trip verbatim and match results by the full id", async () => {
  const { handleExecMessage } = await import("../lib/cursor/exec.js");
  const { completionToolCall } = await import("../lib/cursor/completion.js");
  const joined = "call-1afe950d-a6d1-4c3d-8de3-e12a47cb982d-4\nfc_p49ASx6-4SRMt5-e204baa9-aws_ue1_0";
  const seen = [];

  const handled = handleExecMessage(
    { id: 7, execId: "exec-fixture", message: { case: "mcpArgs", value: { toolName: "supernova", toolCallId: joined, providerIdentifier: "pi" } } },
    [{ name: "supernova" }],
    () => {},
    exec => seen.push(exec),
  );

  assert.equal(handled, true);
  assert.equal(seen[0].toolCallId, joined, "the wire id is used verbatim, never split or sanitized");

  const nativeSeen = [];

  const nativeHandled = handleExecMessage(
    { id: 8, execId: "exec-native", message: { case: "writeArgs", value: { path: "/fixture.txt", fileText: "x", toolCallId: joined } } },
    [{ name: "write" }],
    () => {},
    exec => nativeSeen.push(exec),
  );

  assert.equal(nativeHandled, true);
  assert.equal(nativeSeen[0].toolCallId, joined, "native execs keep the wire id verbatim too");
  assert.equal(completionToolCall(seen[0], 0).id, joined, "the OpenAI chunk carries the exact id Pi will echo back");
  assert.ok(new Map([[joined, { content: "ok" }]]).has(seen[0].toolCallId), "result matching keys on the full id");
});

test("Cursor diagnostic failures cannot prevent shutdown or spill private payloads to stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "rotator-debug-failure-"));

  const script = `
    import { debugLog } from ${JSON.stringify(new URL("../lib/cursor/debug.js", import.meta.url).href)};
    import { debugExtensionLog } from ${JSON.stringify(new URL("../lib/cursor/diagnostics.js", import.meta.url).href)};
    import { registerSessionLifecycleCleanup } from ${JSON.stringify(new URL("../lib/cursor/index.js", import.meta.url).href)};
    import { startProxy, stopProxy, getProxyPort } from ${JSON.stringify(new URL("../lib/cursor/proxy.js", import.meta.url).href)};
    import { activeBridges, conversationStates, deriveBridgeKeyFromSessionId, deriveConversationKeyFromSessionId } from ${JSON.stringify(new URL("../lib/cursor/conversation-registry.js", import.meta.url).href)};
    const cyclic = { text: 'fixture-private-payload' }; cyclic.self = cyclic;
    const report = {};
    for (const [name, logger] of [['proxySerializationFailed', debugLog], ['extensionSerializationFailed', debugExtensionLog]]) {
      try { logger('fixture', cyclic); report[name] = false; } catch { report[name] = true; }
    }
    const handlers = new Map();
    registerSessionLifecycleCleanup({ on: (name, handler) => handlers.set(name, handler) });
    const id = 'logging-failure-fixture';
    let destroyed = false;
    const bridge = { alive: true, write() {}, destroy() { destroyed = true; this.alive = false; } };
    try {
      await startProxy(async () => 'fixture-only');
      activeBridges.set(deriveBridgeKeyFromSessionId(id), { bridge });
      conversationStates.set(deriveConversationKeyFromSessionId(id), { blobStore: new Map() });
      try { await handlers.get('session_shutdown')({ reason: 'quit' }, { sessionManager: { getSessionId: () => id } }); report.shutdownFailed = false; } catch { report.shutdownFailed = true; }
      Object.assign(report, { proxyStopped: getProxyPort() === undefined, bridgesCleared: activeBridges.size === 0, conversationsCleared: conversationStates.size === 0, bridgeDestroyed: destroyed });
    } finally { stopProxy(); }
    console.log(JSON.stringify(report));
  `;

  const child = spawnSync(process.execPath, ["--import", new URL("./host-modules.mjs", import.meta.url).href, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000, env: { ...process.env, PI_CURSOR_PROVIDER_DEBUG: "1", PI_CURSOR_PROVIDER_DEBUG_FILE: dir, PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE: dir } });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { proxySerializationFailed: false, extensionSerializationFailed: false, shutdownFailed: false, proxyStopped: true, bridgesCleared: true, conversationsCleared: true, bridgeDestroyed: true });
  assert.equal(child.stderr, "", "debug-log failures must not fall back to printing private request data");
});

test("Cursor refresh errors report status without exposing token-bearing response bodies", async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("fixture-private-refresh-token")); controller.close(); },
    cancel() { cancelled = true; },
  }), { status: 401 });

  try {
    await assert.rejects(refreshCursorToken("fixture-refresh"), error => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /fixture-private-refresh-token/);
      assert.equal(cancelled, true, "an error body is cancelled without being read or retained");

      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("Cursor payload transport binds the host API before its first request without a local peer install", () => {
  const failures = ["Bridge connection lost", "fixture quota exhausted"].map((message, index) => {
    const fixture = streamFixture();
    writeSSEStreamForTests({ bridge: fixture.bridge, bridgeKey: "host-error", convKey: "host-error", modelId: "fixture", completedTurns: [], currentTurn: { userText: "fixture", steps: [] }, req: fixture.req, res: fixture.res });
    fixture.bridge.push(interaction("textDelta", { text: "partial answer" }));

    if (index === 0) fixture.bridge.close(1);
    else fixture.bridge.endStream({ error: { code: "resource_exhausted", message } });

    return { body: fixture.body(), message };
  });

  const command = (process.env.PATH || "").split(delimiter).map(dir => join(dir, "pi")).find(existsSync);
  const entry = process.env.PI_ROTATOR_TEST_HOST || command && realpathSync(command);
  assert.ok(entry, "the installed Pi host supplies the runtime peer");
  const host = new URL(entry.endsWith(".ts") ? "./index.ts" : "./index.js", pathToFileURL(entry)).href;
  const dir = mkdtempSync(join(tmpdir(), "rotator-host-peer-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "provider-payload-stream.js"), readFileSync(new URL("../lib/provider-payload-stream.js", import.meta.url)));
  writeFileSync(join(dir, "cursor-bridge.js"), readFileSync(new URL("../lib/cursor-bridge.js", import.meta.url)));
  mkdirSync(join(dir, "cursor"));

  writeFileSync(join(dir, "cursor/cursor-shared.js"), `
    import { cursorPayloadStream } from '../provider-payload-stream.js';
    export const FALLBACK_MODELS = [];
    export async function ensureCursorProxy() { return 12345; }
    export function registerCursorProvider(pi) {
      pi.registerCommand('probe', { handler: async () => cursorPayloadStream(
        { id: 'fixture', name: 'Fixture', provider: 'cursor', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', input: ['text'], reasoning: false, contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] },
        { apiKey: 'fixture-only', sessionId: 'peer-binding-fixture' }
      ).result() });
    }
  `);

  writeFileSync(join(dir, "index.js"), `
    import { getModel } from '@earendil-works/pi-ai/compat';
    export default async function(pi) {
      if (!getModel('openai', 'gpt-4o-mini')) throw new Error('Host offline model unavailable');
      const { setupCursorSubscription } = await import('./cursor-bridge.js');
      await setupCursorSubscription(pi, { readAuth: () => ({}), slotIds: [], discover: false });
    }
  `);

  const script = `
    import assert from 'node:assert/strict';
    import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(host)};
    let payload, failureBody;
    globalThis.fetch = async (_input, init) => {
      payload = JSON.parse(init.body);
      if (failureBody) return new Response(failureBody, { headers: { 'content-type': 'text/event-stream' } });
      const part = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: 'fixture response' }, finish_reason: null }] };
      const end = { ...part, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      return new Response('data: ' + JSON.stringify(part) + '\\n\\ndata: ' + JSON.stringify(end) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const dir = ${JSON.stringify(dir)};
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }), noExtensions: true, additionalExtensionPaths: [dir + '/index.js'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const result = await loaded.extensions[0].commands.get('probe').handler('', {});
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(result.content[0].text, 'fixture response');
    assert.equal(payload.pi_session_id, 'peer-binding-fixture');
    assert.equal(payload.messages.at(-1).content, 'fixture');
    for (const failure of ${JSON.stringify(failures)}) {
      failureBody = failure.body;
      const failed = await loaded.extensions[0].commands.get('probe').handler('', {});
      assert.equal(failed.stopReason, 'error');
      assert.ok(failed.errorMessage.includes(failure.message), failed.errorMessage);
      assert.equal(failed.content.some(part => part.type === 'text' && part.text.includes(failure.message)), false, 'diagnostics are errors, not assistant text');
    }
    console.log(JSON.stringify({ stopReason: result.stopReason, text: result.content[0].text, sessionId: payload.pi_session_id }));
  `;

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000, cwd: dir, env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { stopReason: "stop", text: "fixture response", sessionId: "peer-binding-fixture" });
  assert.equal(existsSync(join(dir, "node_modules")), false, "a host-bound stream cannot require an installed local Pi peer");
});


test("unrelated Cursor-prefixed metadata cannot authorize replacing a foreign Cursor provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rotator-cursor-owner-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "settings.json"), "{}");
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { "cursor-unrelated": { modelOverrides: { fixture: { name: "foreign metadata" } } } } }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ cursor: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 86400000 } }));
  const pi = fakePi();
  const foreign = { api: "openai-completions", baseUrl: "https://fixture.invalid/v1", models: [] };
  pi.providers.set("cursor", foreign);

  try {
    await piRotator(pi);
    assert.equal(pi.providers.get("cursor"), foreign, "only canonical Cursor account metadata can authorize startup ownership");
    assert.equal(pi.providers.size, 1);
    assert.equal(existsSync(join(dir, "config/pi-rotator/accounts.json")), false);
  } finally {
    stopProxy();

    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});


test("Cursor upstream HTTP rejection survives the real bridge without exposing response bodies", async t => {
  const server = http2.createServer();
  const sessions = new Set();
  let status = 429;
  server.on("session", session => sessions.add(session));
  server.on("stream", stream => {
    stream.on("error", () => {});
    stream.respond({ ":status": status, "content-type": "application/json" });
    stream.end(JSON.stringify({ message: "private-upstream-body-sentinel" }));
  });
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  const originalFactory = bridgeFactory;
  const children = [];
  const closed = [];
  setBridgeFactoryForTests(options => {
    const bridge = originalFactory({ ...options, url: `http://127.0.0.1:${server.address().port}` });
    children.push(bridge);
    closed.push(once(bridge.proc, "close"));

    return bridge;
  });

  try {
    for (const code of [401, 402, 403, 429, 500]) await t.test(`HTTP ${code}`, async () => {
      status = code;
      const fixture = streamFixture();
      handleStreamingResponse({ requestBytes: new Uint8Array(), blobStore: new Map(), mcpTools: [] }, "fixture-local-only", "fixture", `http-${code}`, `http-${code}`, [], { userText: "HTTP rejection fixture", steps: [] }, fixture.req, fixture.res);
      await bounded("upstream HTTP rejection", fixture.done);
      const error = fixture.packets().find(packet => packet.error)?.error;
      assert.match(error?.message ?? "", new RegExp(`HTTP ${code}\\b`));
      assert.ok(!fixture.body().includes("private-upstream-body-sentinel"));
      const unary = await callCursorUnaryRpc({ accessToken: "fixture-local-only", rpcPath: "/fixture/catalog", requestBody: Buffer.from([1]), timeoutMs: 1000 });
      assert.notEqual(unary.exitCode, 0, "non-success unary bodies must not be interpreted as protobuf");
      assert.equal(unary.body.length, 0, "rejected response bodies stay outside the protocol");
    });
  } finally {
    for (const bridge of children) bridge.destroy();
    await Promise.all(closed);

    for (const session of sessions) session.destroy();
    await new Promise(resolve => server.close(resolve));
    setBridgeFactoryForTests();
  }
});
