/**
 * pi-cliffcompaction -- Pi extension.
 *
 * Replaces Pi's LLM summarizer with CliffCompaction (arxiv:2609.26779):
 * grow until the host triggers compaction, then keep head + last K turns
 * verbatim and replace the middle with a mechanical, never-rephrased
 * summary. Prior summaries are discarded (never compact a compaction).
 *
 * Fail-open: if the mechanical pass has nothing to gain, the handler
 * returns undefined and Pi's default path runs. Shadow mode cancels
 * compaction so the original history is sent unchanged.
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { loadConfig, type Config } from "./lib/config.ts";
import { isRecord, type JsonObject, type JsonValue } from "./lib/decode.ts";
import { compactSession, liveFromEntries, type CliffDetails, type HookEntry } from "./lib/pi-hook.ts";

type LastCliff = {
  reason: string;
  at: string;
  details: CliffDetails;
};

function jsonObjectFrom(value: JsonValue): JsonObject {
  // SAFETY: LLM Message is JSON-serializable; reparse to JsonObject.
  const parsed: JsonValue = JSON.parse(JSON.stringify(value));

  if (isRecord(parsed)) {
    return parsed;
  }

  return {};
}

function hookEntriesFromBranch(branchEntries: readonly SessionEntry[]): HookEntry[] {
  const out: HookEntry[] = [];

  for (const entry of branchEntries) {
    if (entry.type === "message") {
      const converted = convertToLlm([entry.message]);
      const msg = converted[0];

      if (msg) {
        // SAFETY: convertToLlm returns a JSON-serializable Message.
        const asJson: JsonValue = JSON.parse(JSON.stringify(msg));
        out.push({ id: entry.id, kind: "message", message: jsonObjectFrom(asJson) });
      }

      continue;
    }

    if (entry.type === "custom_message") {
      const content = entry.content;
      out.push({
        id: entry.id,
        kind: "message",
        message: { role: "user", content: isRecord(content) || Array.isArray(content) ? JSON.parse(JSON.stringify(content)) : content },
      });
      continue;
    }

    if (entry.type === "compaction") {
      out.push({
        id: entry.id,
        kind: "compaction",
        firstKeptEntryId: entry.firstKeptEntryId,
      });
    }
  }

  return out;
}

function formatStatus(cfg: Config, last: LastCliff | null): string {
  const lines = [
    "CliffCompaction " + (cfg.enabled ? "on" : "off") + (cfg.shadow ? " (shadow)" : ""),
    "keepRecent=" + cfg.keepRecent + " resultMaxChars=" + cfg.resultMaxChars + " cmdMaxChars=" + cfg.cmdMaxChars,
    "thoughtMaxChars=" + cfg.thoughtMaxChars + " thinkingMaxChars=" + cfg.thinkingMaxChars + " keepThinking=" + cfg.keepThinking,
    "humanMaxChars=" + cfg.humanMaxChars + " strict=" + cfg.strict,
  ];

  if (last) {
    lines.push(
      "last: " +
        last.reason +
        " @ " +
        last.at +
        " live=" +
        last.details.liveMessages +
        " kept=" +
        last.details.keptMessages +
        " rung=" +
        last.details.rung,
    );
  }

  return lines.join("\n");
}

export default function registerCliffCompaction(pi: ExtensionAPI) {
  let cfg = loadConfig();
  let last: LastCliff | null = null;

  pi.registerCommand("cliff", {
    description: "CliffCompaction status and config (mechanical autocompaction)",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();
      const space = trimmed.indexOf(" ");
      const sub = (space === -1 ? trimmed : trimmed.slice(0, space)) || "status";

      if (sub === "reload") {
        cfg = loadConfig();
        ctx.ui.notify("CliffCompaction config reloaded", "info");
      }

      if (sub === "config") {
        ctx.ui.notify(JSON.stringify(cfg, null, 2), "info");

        return;
      }

      ctx.ui.notify(formatStatus(cfg, last), "info");
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!cfg.enabled) {
      return;
    }

    const { preparation, branchEntries, reason } = event;

    try {
      const entries = hookEntriesFromBranch(branchEntries);
      const live = liveFromEntries(entries);

      const result = compactSession({
        live,
        tokensBefore: preparation.tokensBefore,
        fallbackFirstKeptEntryId: preparation.firstKeptEntryId,
        reason,
        cfg,
      });

      if (cfg.shadow) {
        ctx.ui.setStatus(
          "cliff",
          result
            ? "cliff shadow · would keep " + result.details.keptMessages + " msgs"
            : "cliff shadow · nothing to compact",
        );

        return { cancel: true };
      }

      if (result === null) {
        return;
      }

      last = { reason, at: new Date().toISOString(), details: result.details };
      ctx.ui.setStatus("cliff", "cliff · " + reason + " · kept " + result.details.keptMessages);

      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
          details: result.details,
        },
      };
    } catch {
      return;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    if (!event.fromExtension) {
      return;
    }

    ctx.ui.setStatus("cliff", "cliff · compacted (" + event.reason + ")");
  });
}
