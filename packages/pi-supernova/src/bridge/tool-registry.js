import {isString,isFunction} from '../shared/decode.js';
import {toolIsCallable} from './invoke.js';

// Executor maps outlive individual program bridges.
const indexerExecutors = new WeakMap();

export function createToolRegistry({pi,config,registry,natives,executors,definitions}) {
  let hostSession = null, boundSessionId, invocationContext = null;

function captureHostTool(tool, excluded) {
  return tool && isString(tool.name) && isFunction(tool.execute) && tool.name !== "supernova" && !excluded.has(tool.name);
}

function wrapHostRegister() {
  if (registry || !pi || !isFunction(pi.registerTool)) return;
  const original = pi.registerTool.bind(pi);
  const excluded = new Set(config.excludeTools || []);
  pi.registerTool = (tool) => {
    if (captureHostTool(tool, excluded)) {
      executors.set(tool.name, tool.execute.bind(tool));
      definitions.set(tool.name, tool);
    }

    return original(tool);
  };
}

function evalToolNames() {
  try { return hostSession?.getEvalBridgeToolNames?.() ?? []; }
  catch { return []; }
}

function invocationTools() {
  if (!invocationContext) return [];

  try { return Array.isArray(invocationContext.tools) ? invocationContext.tools : []; }
  catch { return []; }
}

function hostTool(name) {
  const metadata = definitions.get(name);

  if (invocationContext) {
    if (nativeAdapterOwns(name, metadata, true)) return undefined;

    if (!invocationTools().some(tool => tool.name === name)) return undefined;

    // Never call an AgentTool executor directly: the invocation owns validation,
    // exposure, permissions, cancellation, nested receipts and usage accounting.
    return {async execute(_id, args, signal, onUpdate) {
      const outcome = await invocationContext.executeTool(name, args, {signal, onUpdate});

      return {...outcome.result, isError:outcome.isError};
    }};
  }

  if (!hostSession) return undefined;

  // Keep Supernova's transactional adapters for ordinary built-ins. Respect overrides.
  if (nativeAdapterOwns(name, metadata, false)) return undefined;

  try { return hostSession.getToolForEvalBridge?.(name); }
  catch { return undefined; }
}

function callableEnv() {
  return {
    excluded: new Set(config.excludeTools || []),
    hostSession,
    modern: invocationContext !== null,
    modernAllows: name => invocationTools().some(tool => tool.name === name),
    natives,
    executors,
    sessionInvalid,
    nativeOwned,
    evalAllows: name => {
      if (!evalToolNames().includes(name) && definitions.has(name)) return false;

      return !!hostTool(name) || (Object.hasOwn(natives, name) && (!definitions.has(name) || definitions.get(name).sourceInfo?.source === "builtin"));
    },
    listed: name => {
      let activeTools;

      try { activeTools = isFunction(pi?.getActiveTools) ? pi.getActiveTools() : undefined; } catch {}

      if (definitions.has(name) && Array.isArray(activeTools) && !activeTools.includes(name)) return false;

      return executors.has(name) || Object.hasOwn(natives, name);
    },
    hostTool,
  };
}

function isCallable(name) {
  return toolIsCallable(name, callableEnv());
}

// Pi's public catalog intentionally omits executors. The optional indexer
// handshake is synchronous and read-only, never a fallback around a host
// session's eval/approval gate. Withdrawn or ambiguous capabilities fail closed.
function withdrawIndexer() {
  const previous = indexerExecutors.get(executors);

  if (previous && executors.get('isearch') === previous) executors.delete('isearch');
  indexerExecutors.delete(executors);
}

function discoverIndexer(tools) {
  withdrawIndexer();
  const metadata = tools.find(tool=>tool?.name==='isearch');

  if (invocationContext || hostSession || executors.has('isearch') || !indexerMetadataAllowed(metadata)) return;
  const providers = [];

  try {
    if (!pi.getActiveTools?.().includes('isearch')) return;
    pi.events.emit('pi-indexer:readonly-provider',{version:1,parameters:metadata.parameters,sessionId:boundSessionId,accept(provider) {
      if (provider?.name === 'isearch' && provider.parameters === metadata.parameters && provider.annotations?.readOnlyHint === true && isFunction(provider.execute)) providers.push(provider);
    }});
  } catch { return; }

  if (providers.length !== 1) return;
  definitions.set('isearch',{...definitions.get('isearch'),...providers[0]});
  indexerExecutors.set(executors,providers[0].execute);
  executors.set('isearch',providers[0].execute);
}

function listedTools() {
  let listed = [];

  try { listed = pi?.getAllTools?.() ?? []; } catch {}

  return Array.isArray(listed) ? listed : [];
}

function refreshTools() {
  const tools = [...listedTools(), ...invocationTools()];

  for (const tool of tools) {
    if (!isString(tool?.name)) continue;
    definitions.set(tool.name, { ...definitions.get(tool.name), ...tool });

    if (!invocationContext && !hostSession && isFunction(tool.execute)) executors.set(tool.name, tool.execute.bind(tool));
  }

  discoverIndexer(tools);

  return [...definitions.values()].filter(tool => isCallable(tool.name));
}

function externalNames() {
  return [...definitions.keys()].filter(name => !!hostTool(name) || executors.has(name));
}

function bindSession(ctx) {
  const sessionId = sessionIdOf(ctx);
  boundSessionId = sessionId;
  invocationContext = isFunction(ctx?.executeTool) ? ctx : null;

  if (invocationContext) {
    hostSession = null;

    return;
  }

  hostSession = findSession(sessionId);
}

function nativeAdapterOwns(name, metadata, allowMissing) {
  return Object.hasOwn(natives, name) && ((allowMissing && !metadata) || metadata?.sourceInfo?.source === "builtin");
}

function knownBuiltin(name) {
  return !definitions.has(name) || definitions.get(name).sourceInfo?.source === "builtin";
}

function nativeOwned(name) {
  if (!Object.hasOwn(natives,name)) return false;

  if (invocationContext) return knownBuiltin(name);

  return !executors.has(name) && (!hostSession || knownBuiltin(name));
}

function sessionIdOf(ctx) {
  return ctx?.sessionManager?.getSessionId?.();
}

function sessionInvalid() {
  return invocationContext ? sessionIdOf(invocationContext) !== boundSessionId
    : hostSession && (hostSession.isDisposed || sessionIdOf(hostSession) !== boundSessionId);
}

function indexerMetadataAllowed(metadata) {
  return metadata && metadata.exposure === undefined && metadata.annotations?.readOnlyHint !== false && isFunction(pi?.events?.emit);
}

function agentRegistry() {
  return pi?.pi?.AgentRegistry?.global?.();
}

function registrySessions() {
  const registry = agentRegistry();
  let sessions = [];

  try { sessions = registry?.list?.() ?? []; } catch {}

  return Array.isArray(sessions) ? sessions : [];
}

function findSession(sessionId) {
  const sessions = registrySessions();

  return sessionId ? sessions.map(ref => ref.session).find(session => !session?.isDisposed && sessionIdOf(session) === sessionId) ?? null : null;
}

  wrapHostRegister();

  return {refreshTools,isCallable,externalNames,hostTool,evalToolNames,bindSession,get modern(){return invocationContext !== null;},get session(){return hostSession;}};
}
