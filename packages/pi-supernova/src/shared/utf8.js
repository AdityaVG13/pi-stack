function invalidUtf8(target) {
  return new Error("not valid UTF-8 (binary or non-UTF-8 text): " + target + "; inspect or convert it with bash (for example iconv -f latin1 -t utf8 or xxd)");
}

/** Strict text fidelity includes the BOM; individual formats may consume it. */
export function decodeUtf8Strict(bytes, target) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalidUtf8(target); }
}

/** Streaming decode omits only an incomplete tail, never corrupt interior bytes. */
export function decodeUtf8Window(bytes, target = "read window") {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: true }); }
  catch { throw invalidUtf8(target); }
}
