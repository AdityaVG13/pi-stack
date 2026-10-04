import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { entrySize, makeEntry, PrefixStore } from "../lib/store.ts";

function anEntry(chars, cut = 10) {
  return makeEntry(2, { role: "user", content: "x".repeat(chars) }, cut);
}

describe("PrefixStore", () => {
  it("tracks total size on put", () => {
    const store = new PrefixStore();
    const e = anEntry(1000);
    store.put("h1", e);

    assert.equal(store.nbytes, entrySize(e.summary));
    assert.ok(store.nbytes >= 1000);
    assert.equal(e.size, store.nbytes);
  });

  it("replacing a key does not double count", () => {
    const store = new PrefixStore();
    store.put("h1", anEntry(5000));
    store.put("h1", anEntry(1000));

    assert.equal(store.size, 1);
    assert.ok(store.nbytes < 2000);
  });

  it("evicts least recently used until under the byte budget", () => {
    const store = new PrefixStore(4096, 10_000);

    for (let i = 0; i < 6; i++) {
      store.put("h" + i, anEntry(3000));
    }

    assert.ok(store.nbytes <= 10_000);
    assert.equal(store.size, 3);
    assert.equal(store.get("h0"), undefined);
    assert.ok(store.get("h5"));
  });

  it("get refreshes recency so a hot entry survives", () => {
    const store = new PrefixStore(4096, 10_000);

    for (let i = 0; i < 3; i++) {
      store.put("h" + i, anEntry(3000));
    }

    store.get("h0");
    store.put("h9", anEntry(3000));

    assert.ok(store.get("h0"));
    assert.equal(store.get("h1"), undefined);
  });

  it("entry count still bounds when entries are tiny", () => {
    const store = new PrefixStore(4, 10 ** 9);

    for (let i = 0; i < 20; i++) {
      store.put("h" + i, anEntry(10));
    }

    assert.equal(store.size, 4);
    assert.ok(store.get("h19"));
  });

  it("rejects oversized admissions without evicting useful entries", () => {
    const store = new PrefixStore(4096, 100);
    const small = anEntry(10);
    store.put("small", small);
    store.put("big", anEntry(50_000));
    store.put("small", anEntry(50_000));

    assert.equal(store.size, 1);
    assert.equal(store.get("big"), undefined);
    assert.equal(store.get("small"), small);
    assert.equal(store.nbytes, entrySize(small.summary));
    assert.ok(store.nbytes <= store.maxBytesLimit);
  });

  it("zero entry or byte capacity disables admission", () => {
    for (const store of [new PrefixStore(0, 1000), new PrefixStore(10, 0)]) {
      store.put("entry", anEntry(1));

      assert.equal(store.size, 0);
      assert.equal(store.nbytes, 0);
      assert.equal(store.get("entry"), undefined);
    }
  });

  it("charges UTF-8 bytes for non-ASCII entries before admission", () => {
    const store = new PrefixStore(4, 120);
    const entry = makeEntry(0, { role: "user", content: "😀".repeat(40) }, 1);
    store.put("unicode", entry);

    assert.ok(entrySize(entry.summary) > 120);
    assert.equal(store.size, 0);
    assert.equal(store.nbytes, 0);
  });

  it("admits an exact byte fit but refuses one byte over", () => {
    const entry = anEntry(50);
    const store = new PrefixStore(1, entrySize(entry.summary));
    store.put("exact", entry);
    store.put("over", anEntry(51));

    assert.equal(store.get("exact"), entry);
    assert.equal(store.get("over"), undefined);
    assert.equal(store.nbytes, store.maxBytesLimit);
  });

  it("entrySize never throws on unserializable summaries", () => {
    assert.equal(entrySize({ content: { nope: undefined } }), 0);
  });

  it("default budget holds a realistic working set", () => {
    const store = new PrefixStore();

    for (let i = 0; i < 200; i++) {
      store.put("h" + i, anEntry(50_000));
    }

    assert.equal(store.size, 200);
  });
});
