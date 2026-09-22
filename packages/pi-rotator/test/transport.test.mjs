import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRANSPORT_CONFIG,
  TRANSPORT_FAMILIES,
  isTransportFamily,
  readTransportConfig,
  resolveMode,
} from "../lib/transport.js";

describe("transport", () => {
  it("owns the six multi-account families", () => {
    assert.deepEqual(TRANSPORT_FAMILIES, [
      "anthropic",
      "openai-codex",
      "kimi-coding",
      "qwen",
      "cursor",
      "ollama",
    ]);
    assert.equal(isTransportFamily("openai-codex"), true);
    assert.equal(isTransportFamily("cursor"), true);
    assert.equal(isTransportFamily("xai"), false);
  });

  it("reads routing state from the transport config", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-transport-"));

    writeFileSync(join(dir, TRANSPORT_CONFIG), JSON.stringify({ enabled: false }));
    assert.deepEqual(readTransportConfig(dir), {
      routingOff: true,
      onlyActive: false,
      present: true,
    });

    writeFileSync(
      join(dir, TRANSPORT_CONFIG),
      JSON.stringify({ enabled: true, onlyActive: true }),
    );
    assert.deepEqual(readTransportConfig(dir), {
      routingOff: false,
      onlyActive: true,
      present: true,
    });
  });

  it("treats missing or broken config as routing-on", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-transport-missing-"));

    assert.equal(readTransportConfig(dir).routingOff, false);

    writeFileSync(join(dir, TRANSPORT_CONFIG), "not json");
    assert.equal(readTransportConfig(dir).routingOff, false);
  });

  it("requires exact false/true: absent keys keep transport defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-rotator-transport-keys-"));

    // Older configs lack the keys; the transport defaults to routing on.
    writeFileSync(join(dir, TRANSPORT_CONFIG), JSON.stringify({}));
    assert.deepEqual(readTransportConfig(dir), {
      routingOff: false,
      onlyActive: false,
      present: true,
    });

    writeFileSync(join(dir, TRANSPORT_CONFIG), JSON.stringify({ enabled: 0 }));
    assert.equal(readTransportConfig(dir).routingOff, false);
  });

  it("resolves modes with rivals first", () => {
    assert.equal(
      resolveMode({ transportPresent: false, routingOff: false, rivals: [] }),
      "standalone",
    );
    assert.equal(
      resolveMode({ transportPresent: true, routingOff: true, rivals: [] }),
      "transport",
    );
    assert.equal(
      resolveMode({ transportPresent: true, routingOff: false, rivals: [] }),
      "standby-transport",
    );
    assert.equal(
      resolveMode({ transportPresent: true, routingOff: true, rivals: ["pi-failover"] }),
      "standby-rivals",
    );
    assert.equal(
      resolveMode({ transportPresent: false, routingOff: false }),
      "standalone",
    );
  });
});
