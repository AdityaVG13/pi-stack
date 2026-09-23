import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_IMAGE_TOKENS,
  MAX_IMAGE_TOKENS,
  dimensions,
  imagePayloads,
  tokensForPayload,
} from "../lib/images.ts";
import { billableChars, estimateTokens, messageChars } from "../lib/engine.ts";
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

describe("payload discovery and estimates", () => {
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
