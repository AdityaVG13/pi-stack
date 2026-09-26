/**
 * pi-model-sync: keep Pi models fresh.
 *
 * /model-sync walks every provider Pi knows (built-in and extension
 * registered), lists each live catalog with that provider's own
 * credentials, enriches from models.dev, and writes missing models to
 * models.json as tagged managed entries. One provider's dead token or
 * missing list endpoint skips just that provider, never the run.
 *
 * Host boundary: index.js only wires Pi APIs (registerCommand, registry,
 * ui). All logic lives in lib/ over injected deps, hermetically tested.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isFunction, isNonEmptyString, isString } from "./lib/decode.js";
import { runSync } from "./lib/sync.js";

// Project law: every outbound request carries this User-Agent.
export const USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";

const HELP = [
  "model-sync: refresh Pi model catalogs from live provider lists.",
  "",
  "  /model-sync             sync all logged-in providers",
  "  /model-sync <provider>  sync one provider only",
  "  /model-sync --dry-run   report only; models.json untouched",
  "  /model-sync --refresh   refetch models.dev now; ignore the 24h cache",
  "",
  "Writes tagged entries to models.json (backed up first). Hand-written",
  "entries are never touched; managed entries refresh in place.",
].join("\n");

const FLAGS = { "--dry-run": "dryRun", "--refresh": "refresh", "--help": "help", "-h": "help" };

export function parseArgs(raw) {
  const parsed = { dryRun: false, filter: undefined, help: false, refresh: false, error: undefined };
  // Hosts pass a string; be liberal like pi-rotator and join arrays.
  const text = Array.isArray(raw) ? raw.join(" ") : raw;

  if (!isString(text)) {
    return parsed;
  }

  for (const token of text.split(/\s+/).filter((part) => part !== "")) {
    // hasOwn, not lookup: inherited keys (toString) are positionals, not flags.
    if (Object.hasOwn(FLAGS, token)) {
      parsed[FLAGS[token]] = true;
    } else if (token.startsWith("--")) {
      parsed.error = `unknown flag "${token}"`;

      return parsed;
    } else if (parsed.filter === undefined) {
      parsed.filter = token;
    } else {
      parsed.error = `unexpected argument "${token}"`;

      return parsed;
    }
  }

  return parsed;
}

// models.json location: explicit env override first (also the test seam),
// then the host helper, then the default agent dir.
export async function resolveModelsPath() {
  if (isNonEmptyString(process.env.MODELSYNC_MODELS_PATH)) {
    return process.env.MODELSYNC_MODELS_PATH;
  }

  try {
    const host = await import("@earendil-works/pi-coding-agent");

    if (isFunction(host.getModelsPath)) {
      return host.getModelsPath();
    }
  } catch {
    // Outside Pi (tests, scripts): fall through to the default.
  }

  // Mirror Pi's own default (config.getAgentDir): env override with tilde
  // expansion, else ~/.pi/agent. Only reachable outside Pi; inside Pi the
  // host helper above wins.
  const envDir = process.env.PI_CODING_AGENT_DIR;

  if (isNonEmptyString(envDir)) {
    const expanded = envDir === "~" ? homedir() : envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;

    return join(expanded, "models.json");
  }

  return join(homedir(), ".pi", "agent", "models.json");
}

function attempt(run) {
  try {
    run();

    return true;
  } catch {
    return false;
  }
}

// Persistent widget beats the transient notify flash; notify stays as the
// fallback. All cosmetic failures are swallowed: the report text is the
// return value either way.
function showText(ctx, text) {
  const body = String(text);

  if (
    ctx?.ui?.setWidget != null &&
    attempt(() => ctx.ui.setWidget("pi-model-sync", body.split("\n"), { placement: "aboveEditor" }))
  ) {
    return body;
  }

  if (ctx?.ui?.notify != null) {
    attempt(() => ctx.ui.notify(body, "info"));
  }

  return body;
}

async function onCommand(raw, ctx) {
  const args = parseArgs(raw);

  if (args.error !== undefined) {
    return showText(ctx, `${args.error}\n\n${HELP}`);
  }

  if (args.help) {
    return showText(ctx, HELP);
  }

  if (ctx?.modelRegistry === undefined) {
    return showText(ctx, "model-sync: this Pi version exposes no model registry; update Pi and retry.");
  }

  const modelsPath = await resolveModelsPath();

  const result = await runSync({
    registry: ctx.modelRegistry,
    fetchImpl: globalThis.fetch,
    fs,
    modelsPath,
    userAgent: USER_AGENT,
    filter: args.filter,
    dryRun: args.dryRun,
    refresh: args.refresh,
  });

  return showText(ctx, result.lines.join("\n"));
}

export default function piModelSync(pi) {
  pi.registerCommand("model-sync", {
    description: "Refresh model catalogs from live providers into models.json",
    handler: (raw, ctx) => onCommand(raw, ctx),
  });
}
