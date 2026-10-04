import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindRoutingHooks } from "../lib/runtime.js";
import { createAccountUsage, removeAccount } from "../lib/management.js";
import { removeCommand } from "../lib/account-commands.js";
import { normalizeConfig } from "../lib/config.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rotator-management-"));
  const auth = { "openai-codex": { type: "oauth", access: "fixture-one", accountId: "one" }, "openai-codex-account-2": { type: "oauth", access: "fixture-two", accountId: "two" }, qwen: { type: "api_key", key: "fixture-qwen" }, unrelated: { type: "api_key", key: "fixture-other" } };
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));

  const family = { base: "openai-codex", slots: ["openai-codex", "openai-codex-account-2"], cooldowns: new Map(), drained: new Map(), sessions: new Map() };

  return { dir, auth, family, state: { families: new Map([[family.base, family]]), config: { cooldownMs: 1000 }, mode: "standalone" } };
}

test("usage uses per-account credentials, caches metadata, honors provider verdicts and never renders keys", async () => {
  const f = fixture();
  const requests = [];

  const fetchImpl = async (_url, options) => {
    const headers = new Headers(options.headers);
    const token = headers.get("authorization");
    requests.push({ account: headers.get("chatgpt-account-id"), token, agent: headers.get("user-agent") });

    return new Response(JSON.stringify({ email: token === "Bearer fixture-one" ? "one@example.invalid" : "two@example.invalid", plan_type: "plus", rate_limit: { allowed: token !== "Bearer fixture-one", primary_window: { used_percent: 100, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }), { status: 200 });
  };

  const usage = createAccountUsage(f.dir, f.state, { fetchImpl });
  const first = await usage.describe(["openai-codex", "openai-codex-account-2", "qwen"], true);
  assert.match(first, /one@example.invalid/);
  assert.match(first, /two@example.invalid/);
  assert.match(first, /no usage endpoint/);
  assert.doesNotMatch(first, /fixture-one|fixture-two|fixture-qwen/);
  assert.ok(f.family.cooldowns.get("openai-codex") > Date.now());
  assert.equal(f.family.cooldowns.has("openai-codex-account-2"), false, "a provider's allowed=true outranks arithmetic forecasting");
  assert.deepEqual(requests.map(r => r.account), ["one", "two"]);
  assert.ok(requests.every(r => r.agent === "OpenAI File Downloader, XaiImageApiFetch/1.0"));
  const original = requests.length;
  await usage.describe(["openai-codex"], false);
  assert.equal(requests.length, original, "cached view does not spend another quota probe");
  f.auth["openai-codex"].access = "fixture-renewed";
  writeFileSync(join(f.dir, "auth.json"), JSON.stringify(f.auth));
  assert.match(await usage.describe(["openai-codex"], false), /two@example.invalid/, "changed credential invalidates its cached identity");
});

test("usage status belongs to the current account, credentials and session after asynchronous work", async t => {
  for (const failure of [false, true]) for (const changed of ["credentials", "model", "session"]) await t.test(changed + (failure ? " with old auth failure" : " with old quota response"), async () => {
    const f = fixture();
    let release;
    let reject;
    const deferred = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    let blockAuth = failure;
    let session = "original";
    let widget;

    const ctx = { model: { provider: "openai-codex" }, sessionManager: { getSessionId: () => session }, ui: { setStatus: (_key, value) => { widget = value; } }, modelRegistry: { getProviderAuth: async () => {
      if (!blockAuth) return;

      started();

      return deferred;
    } } };

    const response = used => new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: { used_percent: used, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }), { status: 200 });

    const usage = createAccountUsage(f.dir, f.state, { fetchImpl: async (_url, options) => {
      if (new Headers(options.headers).get("chatgpt-account-id") !== "one") return response(80);

      started();

      return deferred;
    } });

    const pending = usage.updateStatus(ctx, "openai-codex");
    await entered;
    blockAuth = false;

    if (changed === "credentials") {
      f.auth["openai-codex"] = { ...f.auth["openai-codex"], access: "fixture-replaced", accountId: "replacement" };
      writeFileSync(join(f.dir, "auth.json"), JSON.stringify(f.auth));
      await usage.updateStatus(ctx, "openai-codex");
    } else if (changed === "model") ctx.model = { provider: "unrelated" };
    else session = "replacement";

    const current = widget;

    if (failure) reject(new Error("fixture prior auth failure"));
    else release(response(10));
    await pending;

    assert.equal(widget, current, "stale completions must not overwrite the current usage widget");
  });
});

test("late response status for a foreign current account cannot invalidate the current widget request", async () => {
  const f = fixture();
  const replies = new Map();
  let oneStarted;
  let twoStarted;
  const one = new Promise(resolve => { oneStarted = resolve; });
  const two = new Promise(resolve => { twoStarted = resolve; });
  let widget;
  const ctx = { model: { provider: "openai-codex" }, ui: { setStatus: (_key, value) => { widget = value; } } };

  const usage = createAccountUsage(f.dir, f.state, { fetchImpl: (_url, options) => new Promise(resolve => {
    const account = new Headers(options.headers).get("chatgpt-account-id");
    replies.set(account, resolve);

    if (account === "one") oneStarted();
    else twoStarted();
  }) });

  const old = usage.updateStatus(ctx, "openai-codex");
  await one;
  ctx.model = { provider: "openai-codex-account-2" };

  const current = usage.updateStatus(ctx, ctx.model.provider);
  await two;

  const late = usage.updateStatus(ctx, "openai-codex");

  for (const resolve of replies.values()) resolve(new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }), { status: 200 }));

  await Promise.all([old, current, late]);

  assert.match(widget, /^openai-codex-account-2/, "the active account's completion remains publishable after a late old-account event");
});

test("account removal only removes the selected login and refuses the active account", async () => {
  const f = fixture();
  const ctx = { model: { provider: "openai-codex", id: "same-model" }, modelRegistry: { refresh: async () => {} } };
  assert.throws(() => removeAccount(f.dir, "openai-codex", ctx), /active/);
  const remaining = await removeAccount(f.dir, "openai-codex-account-2", ctx);
  assert.equal(remaining["openai-codex-account-2"], undefined);
  assert.deepEqual(remaining.unrelated, f.auth.unrelated);
  assert.deepEqual(remaining["openai-codex"], f.auth["openai-codex"]);
});

test("response quota and drain stay attached to the request account after a manual handoff", async () => {
  const f = fixture();
  const model = { provider: "openai-codex", id: "same-model", api: "openai-codex-responses" };
  Object.assign(f.family, { status: "active", ttlMs: 300000, strategy: "balanced" });
  Object.assign(f.state, { requests: new Map(), config: { ...f.state.config, fastMode: false, debugLog: false }, usage: createAccountUsage(f.dir, f.state), usageEnabled: false });
  const handlers = new Map();
  const pi = { on: (name, handler) => handlers.set(name, handler) };
  const ctx = { model, sessionManager: { getSessionId: () => "fixture-session" } };
  bindRoutingHooks(pi, f.dir, f.state, { changed: false });
  await handlers.get("before_provider_request")({ payload: { messages: [] } }, ctx);
  ctx.model = { ...model, provider: "openai-codex-account-2" };
  await handlers.get("after_provider_response")({ status: 200, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600) } }, ctx);
  assert.ok(f.family.cooldowns.get(model.provider) > Date.now(), "only the account whose quota headers were received is cooled");
  assert.equal(f.family.cooldowns.has(ctx.model.provider), false);
  assert.equal(f.family.drained.get(model.provider), 1);
  assert.equal(f.family.drained.has(ctx.model.provider), false);
});


test("sweep: quota replies cannot cool or label replacement credentials", async t => {
  for (const refetch of [false, true]) await t.test(refetch ? "with a replacement fetch" : "without another fetch", async () => {
    const f = fixture();
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });

    const usage = createAccountUsage(f.dir, f.state, { fetchImpl: async (_url, options) => {
      if (new Headers(options.headers).get("chatgpt-account-id") === "replacement") return new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }), { status: 200 });
      entered();

      return new Promise(resolve => { release = resolve; });
    } });

    const widgets = [];
    const ctx = { model: { provider: "openai-codex" }, sessionManager: { getSessionId: () => "fixture" }, ui: { setStatus: (_key, value) => widgets.push(value) } };
    const pending = usage.updateStatus(ctx, "openai-codex");
    await started;
    f.auth["openai-codex"] = { type: "oauth", access: "replacement-fixture", accountId: "replacement" };
    writeFileSync(join(f.dir, "auth.json"), JSON.stringify(f.auth));

    if (refetch) assert.match(await usage.describe(["openai-codex"], true, ctx), /10% used/);
    release(new Response(JSON.stringify({ email: "previous@example.invalid", rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }), { status: 200 }));
    await pending;
    assert.equal(f.family.cooldowns.has("openai-codex"), false, "the replacement login has not reported exhaustion");
    assert.deepEqual(widgets, [undefined], "obsolete usage cannot label the replacement login");
    await usage.updateStatus(ctx, "openai-codex");
    assert.match(widgets.at(-1), /90% left/);
    assert.equal(f.family.cooldowns.has("openai-codex"), false);
  });
});

test("a failed quota probe cannot label replacement credentials without another status request", async () => {
  const f = fixture();
  let reject;
  const widgets = [];
  const ctx = { model: { provider: "openai-codex" }, ui: { setStatus: (_key, value) => widgets.push(value) } };
  const usage = createAccountUsage(f.dir, f.state, { fetchImpl: () => new Promise((_resolve, fail) => { reject = fail; }) });
  const pending = usage.updateStatus(ctx, "openai-codex");
  f.auth["openai-codex"] = { type: "oauth", access: "replacement-fixture", accountId: "replacement" };
  writeFileSync(join(f.dir, "auth.json"), JSON.stringify(f.auth));
  reject(new Error("fixture obsolete credential rejected"));
  await pending;
  assert.deepEqual(widgets, [undefined], "a stale failure carries no usage information about the replacement login");
});

function removalFixture() {
  const f = fixture();
  Object.assign(f.state, { preparedAccounts: new Set(), ownedAliases: new Set(), config: normalizeConfig({ debugLog: false }) });
  const stored = () => JSON.parse(readFileSync(join(f.dir, "auth.json"), "utf8"));
  const registry = { refresh: async () => {}, getProvider: id => Object.hasOwn(stored(), id) ? { id } : undefined };

  return { ...f, stored, ctx: { hasUI: false, model: { provider: "qwen" }, modelRegistry: registry } };
}

test("account removal confirmation is an argument, never the provider's name", async () => {
  const f = removalFixture();
  f.auth.confirm = { type: "api_key", key: "fixture-confirm-account" };
  writeFileSync(join(f.dir, "auth.json"), JSON.stringify(f.auth));
  await removeCommand({}, f.dir, f.state, f.state.config, ["remove", "confirm"], f.ctx);
  assert.deepEqual(f.stored(), f.auth, "RPC removal requires explicit confirmation even for a provider called confirm");
  f.ctx.hasUI = true;
  f.ctx.ui = { confirm: async () => false };
  await removeCommand({}, f.dir, f.state, f.state.config, ["remove", "confirm"], f.ctx);
  assert.deepEqual(f.stored(), f.auth, "a provider name cannot bypass a declined confirmation dialog");
  await removeCommand({}, f.dir, f.state, f.state.config, ["remove", "confirm", "confirm"], f.ctx);
  assert.deepEqual(f.stored(), Object.fromEntries(Object.entries(f.auth).filter(([id]) => id !== "confirm")), "the explicit confirmation still permits exactly the requested removal");
});

test("account removal failure warns about partial completion without exposing host errors", async t => {
  for (const phase of ["refresh throws", "refresh rejects", "logout synchronizes"]) await t.test(phase, async () => {
    const f = removalFixture();
    const id = "openai-codex-account-2";
    const failure = new Error("fixture-private-token must never reach UI");

    if (phase === "refresh throws") f.ctx.modelRegistry.refresh = () => { throw failure; };
    else if (phase === "refresh rejects") f.ctx.modelRegistry.refresh = async () => { throw failure; };
    else f.ctx.modelRegistry.getModelRuntime = () => ({ logout: async target => {
      const auth = f.stored();
      delete auth[target];
      writeFileSync(join(f.dir, "auth.json"), JSON.stringify(auth));
      throw failure;
    } });

    const reply = await removeCommand({}, f.dir, f.state, f.state.config, ["remove", id, "confirm"], f.ctx);
    assert.deepEqual(f.stored(), Object.fromEntries(Object.entries(f.auth).filter(([provider]) => provider !== id)), "the failure happened after the selected login was persisted as removed");
    assert.doesNotMatch(reply, /Account not removed|fixture-private-token/, "a post-write synchronization failure cannot be reported as an unchanged login");
    assert.match(reply, /may already be removed/);
  });
});

test("account removal unregisters the owned alias so the slot can be reused", async () => {
  const f = removalFixture();
  const id = "openai-codex-account-2";
  const definition = { base: "openai-codex" };
  f.state.ownedAliases.add(id);
  f.state.nativeAliases = new Map([[id, definition]]);
  const unregistered = [];
  const pi = { unregisterProvider(target) { unregistered.push(target); } };
  const reply = await removeCommand(pi, f.dir, f.state, f.state.config, ["remove", id, "confirm"], f.ctx);
  assert.equal(f.stored()[id], undefined);
  assert.match(reply, /Removed login/);
  assert.deepEqual(unregistered, [id], "a removed numbered alias must leave the host registry");
  assert.equal(f.state.ownedAliases.has(id), false, "the vacated slot must not stay reserved");
  assert.equal(f.state.nativeAliases.has(id), false);
});

test("shorter quota windows retain ownership of usage cooldowns without clearing independent backoff", async t => {
  for (const external of ["none", "later", "earlier"]) await t.test(external, async () => {
    const f = fixture();
    const id = "openai-codex";
    const now = Math.floor(Date.now() / 1000) * 1000;
    f.state.config.cooldownMs = 600000;

    const replies = [
      { allowed: false, reset: now + 300000 },
      { allowed: false, reset: now + 60000 },
      { allowed: true, reset: now + 60000 },
    ];

    const usage = createAccountUsage(f.dir, f.state, { fetchImpl: async () => {
      const reply = replies.shift();

      return new Response(JSON.stringify({ rate_limit: { allowed: reply.allowed, primary_window: { used_percent: reply.allowed ? 0 : 100, reset_at: reply.reset / 1000 } } }), { status: 200 });
    } });

    if (external === "earlier") f.family.cooldowns.set(id, now + 30000);

    await usage.describe([id], true);
    const original = f.family.cooldowns.get(id);
    assert.equal(original, now + 300000);

    if (external === "later") f.family.cooldowns.set(id, original + 60000);

    await usage.describe([id], true);
    assert.equal(f.family.cooldowns.get(id), original + (external === "later" ? 60000 : 0), "another usage observation cannot shorten a cooldown");
    await usage.describe([id], true);
    const remaining = { none: undefined, later: original + 60000, earlier: now + 30000 };
    assert.equal(f.family.cooldowns.get(id), remaining[external], "an allowed verdict clears only the cooldown still owned by usage");
  });
});

test("Ollama cloud usage never forwards cloud credentials to a loopback fallback", async () => {
  const f = fixture();
  f.auth.ollama = { type: "api_key", key: "fixture-cloud-key" };
  writeFileSync(join(f.dir, "auth.json"), JSON.stringify(f.auth));
  const requests = [];

  const usage = createAccountUsage(f.dir, f.state, { fetchImpl: async (url, options) => {
    requests.push({ url, authorization: new Headers(options.headers).get("authorization") });

    return new Response("fixture cloud failure", { status: 503 });
  } });

  const reply = await usage.describe(["ollama"], true);
  assert.match(reply, /usage unavailable; login unchanged/);
  assert.deepEqual(requests, [{ url: "https://ollama.com/api/me", authorization: "Bearer fixture-cloud-key" }], "failure cannot move a cloud bearer to a different origin");
});
