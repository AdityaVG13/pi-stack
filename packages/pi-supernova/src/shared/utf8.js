/** Strict decode: binary or non-UTF-8 text must fail loudly, never as U+FFFD. */
export function decodeUtf8Strict(bytes, target) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    throw new Error("not valid UTF-8 (binary or non-UTF-8 text): " + target + "; inspect or convert it with bash (for example iconv -f latin1 -t utf8 or xxd)");
  }
}

/** Prefix window: the byte cut may split a character, so drop one partial tail. */
export function decodeUtf8Window(bytes) {
  for (let cut = 0; cut <= 3 && cut < bytes.length; cut++) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - cut)); }
    catch { /* a partial character at the cut is expected */ }
  }

  return bytes.toString("utf8");
}
