const JSON_TWO_BYTE = new Set([0x22, 0x5c, 8, 9, 10, 12, 13]);

function jsonAsciiWidth(c) {
  if (JSON_TWO_BYTE.has(c)) return 2;

  if (c < 32) return 6;

  return 1;
}

function jsonUnitWidth(s, i) {
  const c = s.charCodeAt(i);

  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);

    if (d >= 0xDC00 && d <= 0xDFFF) return { add: 2, skip: 2 };

    return { add: 6, skip: 1 };
  }

  if (c >= 0xD800 && c <= 0xDFFF) return { add: 6, skip: 1 };

  return { add: jsonAsciiWidth(c), skip: 1 };
}

/** UTF-16 length of JSON.stringify(s) for a string, without allocating the JSON. */
export function jsonStringLength(s) {
  let n = 2;

  for (let i = 0; i < s.length; ) {
    const unit = jsonUnitWidth(s, i);
    n += unit.add;
    i += unit.skip;
  }

  return n;
}

/** Largest prefix whose JSON.stringify length is <= limit. */
export function maxJsonStringPrefix(s, limit) {
  let used = 2;
  let i = 0;

  while (i < s.length) {
    const unit = jsonUnitWidth(s, i);

    if (used + unit.add > limit) break;
    used += unit.add;
    i += unit.skip;
  }

  return i;
}
