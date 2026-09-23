import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, makeConfig, parseConfig, replaceConfig } from "../lib/config.ts";
import { detect } from "../lib/dialects/index.ts";

describe("config", () => {
  it("parses snake_case and camelCase keys", () => {
    const a = parseConfig({ keep_recent: 1, thought_max_chars: 300 });
    const b = parseConfig({ keepRecent: 1, thoughtMaxChars: 300 });

    assert.equal(a.keepRecent, 1);
    assert.equal(a.thoughtMaxChars, 300);
    assert.equal(b.keepRecent, 1);
    assert.equal(b.thoughtMaxChars, 300);
    assert.equal(a.resultMaxChars, DEFAULT_CONFIG.resultMaxChars);
  });

  it("ignores unknown keys and non-objects", () => {
    assert.equal(parseConfig(null).keepRecent, DEFAULT_CONFIG.keepRecent);
    assert.equal(parseConfig({ keepRecent: "nope" }).keepRecent, DEFAULT_CONFIG.keepRecent);
    assert.equal(makeConfig({ keepRecent: 2 }).keepRecent, 2);
  });

  it("replaceConfig only overrides named fields", () => {
    const next = replaceConfig(DEFAULT_CONFIG, { keepRecent: 1, keepThinking: false });

    assert.equal(next.keepRecent, 1);
    assert.equal(next.keepThinking, false);
    assert.equal(next.resultMaxChars, DEFAULT_CONFIG.resultMaxChars);
  });
});

describe("detect", () => {
  it("maps Anthropic, Chat Completions, and Responses paths", () => {
    assert.equal(detect("/v1/messages").name, "anthropic");
    assert.equal(detect("/v1/chat/completions").name, "openai");
    assert.equal(detect("/v1/responses").name, "openai-responses");
    assert.equal(detect("/v1/messages/count_tokens"), null);
    assert.equal(detect("/v1/responses/compact"), null);
  });
});
