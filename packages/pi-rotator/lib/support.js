import { appendDebug } from "./store.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";



export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}


export function readJson(dir, file) {
  const path = join(dir, file);

  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}


export function safeOn(pi, event, handler) {
  try {
    pi.on(event, async (payload, ctx) => {
      try {
        return await handler(payload, ctx);
      } catch (error) {
        appendDebug(agentDir(), "handler_error", {
          event,
          message: String((error && error.message) || error).slice(0, 200),
        });
      }
    });
  } catch {
    // Older hosts may lack pi.on; rotation degrades to manual /rotator next.
  }
}


// Routine debug chatter honors config.debugLog; the evidence journal never
// does, and neither do errors and warnings (handler_error, standby, and
// transport_warn keep calling appendDebug directly).
export function debugLine(state, dir, kind, fields) {
  if (state.config.debugLog !== false) appendDebug(dir, kind, fields);
}
