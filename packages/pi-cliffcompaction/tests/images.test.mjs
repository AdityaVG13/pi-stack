import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_IMAGE_TOKENS,
  MAX_IMAGE_TOKENS,
  dimensions,
  imagePayloads,
  tokensForPayload,
} from "../lib/images.ts";
import { billableChars, ctxOutgoingBody, Engine, estimateTokens, messageChars } from "../lib/engine.ts";
import { makeConfig } from "../lib/config.ts";
import { DIALECT as ANTHROPIC } from "../lib/dialects/anthropic.ts";
import { DIALECT as RESPONSES } from "../lib/dialects/openai-responses.ts";
import { dumpsDefault } from "../lib/json.ts";

function pngBytes(w, h, payloadBytes = 0) {
  const head = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
    Buffer.from([(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff]),
    Buffer.from([(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff]),
  ]);

  return Buffer.concat([head, Buffer.from([0x08, 0x06, 0x00, 0x00, 0x00]), Buffer.alloc(payloadBytes)]);
}

function jpegBytes(w, h, exifBytes = 0) {
  const exifLen = exifBytes + 2;

  const exif = Buffer.concat([
    Buffer.from([0xff, 0xe1, (exifLen >>> 8) & 0xff, exifLen & 0xff]),
    Buffer.alloc(exifBytes),
  ]);

  const sof = Buffer.concat([
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
    Buffer.from([(h >>> 8) & 0xff, h & 0xff, (w >>> 8) & 0xff, w & 0xff]),
  ]);

  return Buffer.concat([Buffer.from([0xff, 0xd8]), exif, sof, Buffer.alloc(12)]);
}

function dataUri(raw, mime = "image/png") {
  return "data:" + mime + ";base64," + raw.toString("base64");
}

describe("image headers", () => {
  it("reads png dimensions", () => {
    assert.deepEqual(dimensions(pngBytes(1536, 1024)), [1536, 1024]);
  });

  it("reads jpeg dimensions past an exif block", () => {
    assert.deepEqual(dimensions(jpegBytes(800, 600, 4000)), [800, 600]);
  });

  it("reads gif dimensions", () => {
    const raw = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([320 & 0xff, 320 >> 8, 240 & 0xff, 240 >> 8]), Buffer.alloc(8)]);

    assert.deepEqual(dimensions(raw), [320, 240]);
  });

  it("reads webp VP8X dimensions", () => {
    const w = Buffer.alloc(3);
    w.writeUIntLE(1023, 0, 3);
    const h = Buffer.alloc(3);
    h.writeUIntLE(767, 0, 3);

    const raw = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WEBP"),
      Buffer.from("VP8X"),
      Buffer.alloc(8),
      w,
      h,
    ]);

    assert.deepEqual(dimensions(raw), [1024, 768]);
  });

  it("returns null for unreadable bytes", () => {
    assert.equal(dimensions(Buffer.from("not an image at all")), null);
    assert.equal(dimensions(Buffer.alloc(0)), null);
  });
});

describe("image token cost", () => {
  const table = [
    [200, 200, 64],
    [1000, 1000, 1296],
    [1092, 1092, 1521],
    [1920, 1080, 2691],
    [2000, 1500, 3888],
    [3840, 2160, MAX_IMAGE_TOKENS],
  ];

  for (const [width, height, expected] of table) {
    it("matches the published table at " + width + "x" + height, () => {
      assert.equal(tokensForPayload(dataUri(pngBytes(width, height))), expected);
    });
  }

  it("caps huge images because providers downscale", () => {
    const huge = tokensForPayload(dataUri(pngBytes(8000, 8000)));

    assert.equal(huge, MAX_IMAGE_TOKENS);
    assert.ok(huge < 4 * tokensForPayload(dataUri(pngBytes(1024, 1024))));
  });

  it("does not let payload length change the estimate", () => {
    const small = dataUri(pngBytes(1536, 1024, 1000));
    const large = dataUri(pngBytes(1536, 1024, 2_000_000));

    assert.ok(large.length > 100 * small.length);
    assert.equal(tokensForPayload(small), tokensForPayload(large));
  });

  it("falls back to the default for hosted urls", () => {
    assert.equal(tokensForPayload("https://example.com/cat.png"), DEFAULT_IMAGE_TOKENS);
  });

  it("falls back to the default for undecodable payloads", () => {
    assert.equal(tokensForPayload("data:image/png;base64,!!!!"), DEFAULT_IMAGE_TOKENS);
  });
});

describe("raw and Pi image budgeting", () => {
  it("prices raw base64 by dimensions and unknown dimensions conservatively", () => {
    const raw = pngBytes(2576, 1932).toString("base64");

    assert.equal(tokensForPayload(raw), MAX_IMAGE_TOKENS);
    assert.equal(tokensForPayload(pngBytes(200, 200).toString("base64")), 64);
    assert.equal(tokensForPayload("https://example.com/unknown.png"), MAX_IMAGE_TOKENS);
    assert.equal(tokensForPayload("data:image/png;base64,!!!!"), MAX_IMAGE_TOKENS);
  });

  it("recognizes Pi image blocks without billing base64 as text", () => {
    const raw = pngBytes(1000, 1000, 600_000).toString("base64");
    const body = { messages: [{ role: "user", content: [{ type: "image", data: raw, mimeType: "image/png" }] }] };

    assert.deepEqual(imagePayloads(body), [raw]);
    assert.ok(estimateTokens(body) >= 1296);
    assert.ok(estimateTokens(body) < 1400);
  });
});

describe("payload discovery and estimates", () => {
  it("keeps sub-budget JPEG histories with marker fill bytes untouched", () => {
    // A sips-encoded 1x1 JPEG with metadata removed. Filled variants also decode with sips.
    const raw = Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/AP5/6//Z", "base64");
    const sof = raw.indexOf(Buffer.from([0xff, 0xc0]));

    assert.deepEqual(dimensions(raw), [1, 1]);
    assert.ok(sof > 2);

    for (const offset of [2, sof]) {
      for (const count of [1, 3]) {
        const padded = Buffer.concat([raw.subarray(0, offset), Buffer.alloc(count, 0xff), raw.subarray(offset)]);
        const uri = dataUri(padded, "image/jpeg");

        const items = [
          { role: "user", content: "task" },
          { role: "assistant", content: "Inspecting the image." },
          { role: "user", content: [{ type: "input_image", image_url: uri }] },
          { role: "assistant", content: "recent response" },
        ];

        const body = { model: "gpt-5", input: items };
        const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1 });
        const engine = new Engine(cfg);
        const ctx = engine.prepare(body, RESPONSES);

        assert.equal(ctx.compacted, false, "JPEG fill bytes must not turn a one-patch image into an over-budget request");
        assert.equal(ctx.modified, false);
        assert.equal(ctxOutgoingBody(ctx), body);
        assert.equal(ctx.estTokensIn, Math.trunc((dumpsDefault(body).length - uri.length + 4) / 4));
        assert.equal(ctx.estTokensOut, ctx.estTokensIn);
        assert.equal(ctxOutgoingBody(engine.prepare(body, RESPONSES)), body);
        assert.deepEqual(dimensions(padded), [1, 1]);
        assert.equal(tokensForPayload(padded.toString("base64")), 1);
        assert.equal(tokensForPayload(uri), 1);
        const truncated = padded.subarray(0, sof + count + 8);
        assert.equal(dimensions(truncated), null);
        assert.equal(tokensForPayload(truncated.toString("base64")), DEFAULT_IMAGE_TOKENS);
      }
    }

    const fillOnly = Buffer.concat([raw.subarray(0, 2), Buffer.alloc(20, 0xff)]);
    assert.equal(dimensions(fillOnly), null);
    assert.equal(tokensForPayload(fillOnly.toString("base64")), DEFAULT_IMAGE_TOKENS);
  });

  it("keeps a sub-budget Responses history with a 28-byte lossless WebP untouched", () => {
    // cwebp -lossless -z 9 encodes a transparent 1x1 PNG as this valid VP8L file.
    const raw = Buffer.from("UklGRhQAAABXRUJQVlA4TAgAAAAvAAAAEIiICA==", "base64");
    const uri = dataUri(raw, "image/webp");

    const items = [
      { role: "user", content: "task" },
      { role: "assistant", content: "Inspecting the image." },
      { role: "user", content: [{ type: "input_image", image_url: uri }] },
      { role: "assistant", content: "recent response" },
    ];

    const body = { model: "gpt-5", input: items };
    const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1 });
    const ctx = new Engine(cfg).prepare(body, RESPONSES);

    assert.equal(ctx.compacted, false, "a one-patch image must not trigger compaction");
    assert.equal(ctx.modified, false);
    assert.equal(ctxOutgoingBody(ctx), body);
    assert.equal(ctx.estTokensIn, Math.trunc((dumpsDefault(body).length - uri.length + 4) / 4));
    assert.equal(ctx.estTokensOut, ctx.estTokensIn);
    assert.deepEqual(dimensions(raw), [1, 1]);
    assert.equal(tokensForPayload(raw.toString("base64")), 1);
    assert.equal(tokensForPayload(uri), 1);
    assert.equal(dimensions(raw.subarray(0, 24)), null);

    for (const format of ["VP8X", "VP8 "]) {
      const incomplete = Buffer.concat([raw, Buffer.from([1])]);
      incomplete.write(format, 12, "ascii");
      assert.equal(dimensions(incomplete), null);
      assert.equal(tokensForPayload(incomplete.toString("base64")), DEFAULT_IMAGE_TOKENS);
    }
  });

  it("finds payloads in all three dialect shapes", () => {
    const body = {
      messages: [
        { content: [{ type: "image", source: { data: "AAAA" } }] },
        { content: [{ type: "input_image", image_url: "data:image/png;base64,BBBB" }] },
        { content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] },
      ],
    };

    assert.deepEqual(imagePayloads(body), [
      "AAAA",
      "data:image/png;base64,BBBB",
      "https://x/y.png",
    ]);
  });

  it("prices Anthropic URL image sources like other hosted urls, not as JSON text", () => {
    const url = "https://example.com/cat.png";
    const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url } }] }] };

    assert.deepEqual(imagePayloads(body), [url]);
    assert.equal(tokensForPayload(url), DEFAULT_IMAGE_TOKENS);
    assert.ok(estimateTokens(body) >= DEFAULT_IMAGE_TOKENS);
    assert.ok(estimateTokens(body) < DEFAULT_IMAGE_TOKENS + 200);
  });

  it("prices Responses computer screenshots and triggers compaction at their image cost", () => {
    for (const [url, expected] of [
      ["https://example.com/screenshot.png", DEFAULT_IMAGE_TOKENS],
      [dataUri(pngBytes(1000, 1000)), 1296],
    ]) {
      const items = [
        { role: "user", content: "task" },
        { type: "computer_call", call_id: "c0", action: { type: "screenshot" } },
        { type: "computer_call_output", call_id: "c0", output: { type: "computer_screenshot", image_url: url } },
        { role: "assistant", content: "done" },
      ];

      const body = { model: "gpt-5", input: items };
      const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1 });
      const ctx = new Engine(cfg).prepare(body, RESPONSES);

      assert.ok(ctx.estTokensIn >= expected);
      assert.equal(ctx.estTokensIn, estimateTokens(body));
      assert.equal(ctx.compacted, true);
      assert.equal(ctxOutgoingBody(ctx).input.at(-1), items.at(-1));
      assert.ok(ctx.estTokensOut <= cfg.thresholdTokens);
      assert.deepEqual(imagePayloads(body), [url]);
    }
  });

  it("prices code-interpreter image URLs and triggers compaction at their image cost", () => {
    const url = "https://example.com/private-plot.png";

    const items = [
      { role: "user", content: "task" },
      {
        type: "code_interpreter_call", id: "ci_0", status: "completed", container_id: "cntr_0",
        code: 'plot.savefig("plot.png")',
        outputs: [{ type: "logs", logs: "Plot generated." }, { type: "image", url }],
      },
      { role: "user", content: "Check the plot." },
      { role: "assistant", content: "The plot is ready." },
    ];

    const body = { model: "gpt-5", input: items };
    const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1 });
    const engine = new Engine(cfg);
    const ctx = engine.prepare(body, RESPONSES);

    assert.ok(Math.trunc(dumpsDefault(body).length / 4) < cfg.thresholdTokens);
    assert.equal(ctx.compacted, true);
    assert.equal(ctx.estTokensIn, Math.trunc((dumpsDefault(body).length - url.length + DEFAULT_IMAGE_TOKENS * 4) / 4));
    assert.equal(ctx.estTokensIn, estimateTokens(body));
    assert.deepEqual(imagePayloads(body), [url]);
    const out = ctxOutgoingBody(ctx);

    assert.equal(out.input[0], items[0]);
    assert.equal(out.input.at(-1), items.at(-1));
    assert.ok(out.input[1].content[0].text.includes("result: Plot generated."));
    assert.equal(JSON.stringify(out).includes(url), false);
    assert.ok(ctx.estTokensOut <= cfg.thresholdTokens);
    assert.deepEqual(ctxOutgoingBody(engine.prepare(body, RESPONSES)), out);
  });

  it("prices Responses image-generation results by dimensions, not base64 length", () => {
    const cfg = makeConfig({ thresholdTokens: 2000, keepRecent: 1 });

    for (const [payload, expected] of [
      [pngBytes(1000, 1000).toString("base64"), 1296],
      [pngBytes(1000, 1000, 600_000).toString("base64"), 1296],
      ["!!!!", DEFAULT_IMAGE_TOKENS],
    ]) {
      const items = [
        { role: "user", content: "task" },
        { type: "image_generation_call", id: "ig_0", status: "completed", result: payload },
        { role: "user", content: "Continue." },
        { role: "assistant", content: "The image is ready." },
      ];

      const body = { model: "gpt-5", input: items };
      const bill = Math.trunc((dumpsDefault(body).length - payload.length + expected * 4) / 4);
      const engine = new Engine(cfg);
      const ctx = engine.prepare(body, RESPONSES);

      assert.equal(ctx.estTokensIn, bill);
      assert.equal(estimateTokens(body), bill);
      assert.deepEqual(imagePayloads(body), [payload]);
      assert.equal(ctx.compacted, bill > cfg.thresholdTokens);
      assert.equal(ctxOutgoingBody(ctx).input[0], items[0]);
      assert.equal(ctxOutgoingBody(ctx).input.at(-1), items.at(-1));
      assert.ok(ctx.estTokensOut <= cfg.thresholdTokens);
      assert.deepEqual(ctxOutgoingBody(engine.prepare(body, RESPONSES)), ctxOutgoingBody(ctx));

      if (bill <= cfg.thresholdTokens) {
        assert.equal(ctxOutgoingBody(ctx), body);
        const early = new Engine(makeConfig({ thresholdTokens: 1000, keepRecent: 1 })).prepare(body, RESPONSES);
        assert.equal(early.compacted, true);
        assert.ok(early.estTokensOut <= 1000);
        assert.deepEqual(imagePayloads(ctxOutgoingBody(early)), []);
      } else {
        assert.deepEqual(imagePayloads(ctxOutgoingBody(ctx)), []);
      }
    }
  });

  it("invalidates cached image-generation cliffs when the result becomes sub-budget", () => {
    const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1, humanMaxChars: 16 });
    // Complete black PNGs at 1000x1000 and 1x1, decoded locally with sips.
    const original = "iVBORw0KGgoAAAANSUhEUgAAA+gAAAPoAQAAAABl2OlJAAAAkUlEQVR4nO3BMQEAAADCoPVPbQo/oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvgbsPwAB+DGXIQAAAABJRU5ErkJggg==";
    const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

    const call = {
      type: "image_generation_call", id: "ig_0", status: "completed",
      revised_prompt: "Draw a diagram.", result: original,
    };

    const items = [
      { role: "user", content: "task" }, call,
      { role: "user", content: "Keep the complete follow-up instruction, not just its capped excerpt." },
      { role: "assistant", content: "recent response" },
    ];

    const body = { model: "gpt-5", input: items };
    const engine = new Engine(cfg);
    const first = engine.prepare(body, RESPONSES);

    assert.equal(first.compacted, true);
    const output = ctxOutgoingBody(first);
    const cached = engine.prepare(body, RESPONSES);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), output);

    for (const result of [tiny, null]) {
      call.result = result;
      assert.ok(estimateTokens(body) < cfg.thresholdTokens);
      const warm = engine.prepare(body, RESPONSES);
      const cold = new Engine(cfg).prepare(structuredClone(body), RESPONSES);

      assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
      assert.equal(warm.modified, false);
      assert.equal(ctxOutgoingBody(warm), body);
    }

    call.result = original;
    const restored = engine.prepare(body, RESPONSES);
    assert.equal(restored.compacted, false);
    assert.deepEqual(ctxOutgoingBody(restored), output);
  });

  it("invalidates cached Anthropic cliffs when tool-result images become sub-budget", () => {
    const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1, humanMaxChars: 16 });
    // Complete black PNGs at 1000x1000 and 1x1, decoded locally with sips.
    const original = "iVBORw0KGgoAAAANSUhEUgAAA+gAAAPoAQAAAABl2OlJAAAAkUlEQVR4nO3BMQEAAADCoPVPbQo/oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvgbsPwAB+DGXIQAAAABJRU5ErkJggg==";
    const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: original } };
    const text = { type: "text", text: "Screenshot captured." };
    const result = { type: "tool_result", tool_use_id: "t0", content: [text, image] };
    const followUp = "Keep the complete follow-up instruction, not just its capped excerpt.";

    const messages = [
      { role: "user", content: "Inspect the page." },
      { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "computer", input: { action: "screenshot" } }] },
      { role: "user", content: [result] },
      { role: "user", content: followUp },
      { role: "assistant", content: "recent response" },
    ];

    const body = { model: "claude-sonnet-5", max_tokens: 4096, messages };
    const engine = new Engine(cfg);
    const first = engine.prepare(body, ANTHROPIC);

    assert.ok(estimateTokens(body) > cfg.thresholdTokens);
    assert.equal(first.compacted, true);
    const output = ctxOutgoingBody(first);
    assert.ok(output.messages[1].content.includes("result: Screenshot captured."));
    assert.ok(output.messages[1].content.includes("user: " + followUp.slice(0, cfg.humanMaxChars) + "..."));
    assert.deepEqual(imagePayloads(output), []);
    assert.equal(output.messages[0], messages[0]);
    assert.equal(output.messages.at(-1), messages.at(-1));
    const cached = engine.prepare(body, ANTHROPIC);
    assert.equal(cached.compacted, false);
    assert.deepEqual(ctxOutgoingBody(cached), output);

    image.source.data = tiny;

    for (const content of [[text, image], [text]]) {
      result.content = content;
      assert.ok(estimateTokens(body) < cfg.thresholdTokens);
      const warm = engine.prepare(body, ANTHROPIC);
      const cold = new Engine(cfg).prepare(structuredClone(body), ANTHROPIC);

      assert.equal(cold.modified, false);
      assert.deepEqual(ctxOutgoingBody(warm), ctxOutgoingBody(cold));
      assert.equal(warm.modified, false);
      assert.equal(ctxOutgoingBody(warm), body);
      assert.equal(ctxOutgoingBody(warm).messages[3].content, followUp);
      assert.equal(warm.estTokensIn, estimateTokens(body));
    }

    image.source.data = original;
    result.content = [text, image];
    const restored = engine.prepare(body, ANTHROPIC);
    assert.equal(restored.compacted, false);
    assert.deepEqual(ctxOutgoingBody(restored), output);
  });

  it("prices uploaded Responses image references conservatively and triggers compaction", () => {
    const fileId = "file-uploaded-image";

    const histories = [
      [
        { role: "assistant", content: "Inspecting the uploaded image." },
        { role: "user", content: [{ type: "input_image", file_id: fileId }] },
      ],
      [
        { type: "computer_call", call_id: "c0", action: { type: "screenshot" } },
        { type: "computer_call_output", call_id: "c0", output: { type: "computer_screenshot", file_id: fileId } },
      ],
    ];

    for (const history of histories) {
      const items = [{ role: "user", content: "task" }, ...history, { role: "assistant", content: "recent response" }];
      const body = { model: "gpt-5", input: items };
      const cfg = makeConfig({ thresholdTokens: 1000, keepRecent: 1 });
      const ctx = new Engine(cfg).prepare(body, RESPONSES);

      assert.equal(estimateTokens(body), Math.trunc((dumpsDefault(body).length - fileId.length + DEFAULT_IMAGE_TOKENS * 4) / 4));
      assert.deepEqual(imagePayloads(body), [fileId]);
      assert.equal(ctx.estTokensIn, estimateTokens(body));
      assert.equal(ctx.compacted, true);
      assert.equal(ctxOutgoingBody(ctx).input[0], items[0]);
      assert.equal(ctxOutgoingBody(ctx).input.at(-1), items.at(-1));
      assert.ok(ctx.estTokensOut <= cfg.thresholdTokens);
    }
  });

  it("does not treat documents as images", () => {
    assert.deepEqual(imagePayloads({ content: [{ type: "document", source: { data: "x".repeat(5000) } }] }), []);
  });

  it("is no longer dominated by base64", () => {
    const uri = dataUri(pngBytes(1536, 1024, 2_000_000));

    const body = {
      model: "m",
      input: [
        { content: [{ type: "input_text", text: "hello ".repeat(100) }] },
        { content: [{ type: "input_image", image_url: uri }] },
      ],
    };

    const est = estimateTokens(body);

    assert.ok(uri.length > 2_600_000);
    assert.ok(est < 5_000);
    assert.ok(est > tokensForPayload(uri));
  });

  it("leaves text-only bodies on the chars/4 estimate", () => {
    const body = { model: "m", input: [{ content: [{ type: "input_text", text: "x".repeat(40_000) }] }] };

    assert.equal(estimateTokens(body), Math.trunc(dumpsDefault(body).length / 4));
  });

  it("keeps many screenshots in a sane range", () => {
    const uri = dataUri(pngBytes(1536, 1024, 1_000_000));
    const input = [];

    for (let i = 0; i < 32; i++) {
      input.push({ content: [{ type: "input_image", image_url: uri }] });
    }

    const est = estimateTokens({ input });

    assert.ok(est > 32 * 2_000);
    assert.ok(est < 32 * MAX_IMAGE_TOKENS);
    assert.ok(est < 200_000);
  });

  it("prices a message as billableChars plus separator", () => {
    const uri = dataUri(pngBytes(1536, 1024, 400_000));
    const msg = { role: "user", content: [{ type: "image", source: { data: uri } }] };

    assert.equal(messageChars(msg), billableChars(msg) + 2);
  });

  it("agrees between per-message replay cost and the trigger", () => {
    const uri = dataUri(pngBytes(1536, 1024, 400_000));
    const msgs = [];

    for (let i = 0; i < 8; i++) {
      msgs.push({ role: "user", content: [{ type: "image", source: { data: uri } }] });
    }

    const body = { model: "m", messages: msgs };
    let per = 0;

    for (const m of msgs) {
      per += messageChars(m);
    }

    const perMsgTokens = Math.trunc(per / 4);

    assert.ok(perMsgTokens <= estimateTokens(body) + 8);
    assert.ok(perMsgTokens < 8 * MAX_IMAGE_TOKENS + 1_000);
  });
});
