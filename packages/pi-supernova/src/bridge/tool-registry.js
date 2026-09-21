import {isString,isFunction} from '../shared/decode.js';
import {toolIsCallable} from './invoke.js';

export function createToolRegistry({pi,config,registry,natives,executors,definitions}) {
  let hostSession = null, boundSessionId;
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

function hostTool(name) {
  if (!hostSession) return undefined;
  const metadata = definitions.get(name);

  // Keep Supernova's transactional adapters for ordinary built-ins. Respect overrides.
  if (Object.hasOwn(natives, name) && metadata?.sourceInfo?.source === "builtin") return undefined;

  try { return hostSession.getToolForEvalBridge?.(name); }
  catch { return undefined; }
}

function callableEnv() {
  return {
    excluded: new Set(config.excludeTools || []),
    hostSession,
    natives,
    executors,
    sessionInvalid: () => hostSession && (hostSession.isDisposed || hostSession.sessionManager?.getSessionId?.() !== boundSessionId),
    nativeOwned: name => Object.hasOwn(natives, name) && !executors.has(name)
      && (!hostSession || !definitions.has(name) || definitions.get(name).sourceInfo?.source === "builtin"),
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

function refreshTools() {
  let listed = [];

  try { listed = pi?.getAllTools?.() ?? []; } catch {}
  const tools = Array.isArray(listed) ? listed : [];

  for (const tool of tools) {
    if (!isString(tool?.name)) continue;
    definitions.set(tool.name, { ...definitions.get(tool.name), ...tool });

    if (!hostSession && isFunction(tool.execute)) executors.set(tool.name, tool.execute.bind(tool));
  }

  return [...definitions.values()].filter(tool => isCallable(tool.name));
}

function externalNames() {
  return [...definitions.keys()].filter(name => !!hostTool(name) || executors.has(name));
}
function bindSession(ctx) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  boundSessionId = sessionId;
  const registry = pi?.pi?.AgentRegistry?.global?.();
  let sessions = [];

  try { sessions = registry?.list?.() ?? []; } catch {}
  if (!Array.isArray(sessions)) sessions = [];
  hostSession = sessionId
    ? sessions.map(ref => ref.session).find(session => !session?.isDisposed && session?.sessionManager?.getSessionId?.() === sessionId) ?? null
    : null;
}
  wrapHostRegister();
  return {refreshTools,isCallable,externalNames,hostTool,evalToolNames,bindSession,get session(){return hostSession;}};
}
