import {isFunction} from '../shared/decode.js';

const PROGRESS_FRAME_MS = 80;

/**
 * Live trace updates for the card. The first update is immediate (seeds the result slot);
 * later ones are coalesced to one host re-render per frame so a tight loop of nova.calls
 * is not throttled by the TUI. A throwing host callback must never break the run.
 */
export function progressEmitter(onUpdate) {
  if (!isFunction(onUpdate)) return Object.assign(() => {}, { flush() {} });
  let pending = null;
  let timer = null;
  let lastSent = -Infinity;

  const send = () => {
    timer = null;

    if (pending === null) return;
    // Snapshot only at emission, not on every tool event. Completed records must
    // not mutate a previously emitted frame while Pi is still consuming it.
    const trace = pending.map(record => ({ ...record }));
    pending = null;
    lastSent = performance.now();

    try {
      onUpdate({ content: [{ type: "text", text: "" }], details: { trace, running: true } });
    } catch {}
  };

  const emit = (trace) => {
    pending = trace;

    if (timer !== null) return;
    const wait = PROGRESS_FRAME_MS - (performance.now() - lastSent);

    if (wait <= 0) send();
    else {
      timer = setTimeout(send, wait);
      timer.unref?.();
    }
  };

  emit.flush = () => {
    if (timer !== null) clearTimeout(timer);
    pending = null;
    timer = null;
  };

  return emit;
}
