/* oxlint-disable anti-slop/require-readable-spacing, anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- Licensed/generated upstream reuse; protocol/style preserved, see cursor/PROVENANCE.json. */
/**
 * The handle around one bridge child process.
 *
 * Cursor talks over a long-lived HTTP/2 stream, and the conversation is genuinely
 * bidirectional: while the model streams its answer, Cursor keeps asking us for blobs and we
 * keep answering on the same pipe. So the pipe can be closed from our side — a cancelled turn,
 * a session teardown, a compaction that starts a new conversation — while replies to Cursor's
 * requests are still in flight.
 *
 * A write into a closed pipe does not fail where it is written. Node reports
 * ERR_STREAM_WRITE_AFTER_END on a later tick, as an `error` event on the stream, which walks
 * straight past the try/catch at the call site and, with no listener, becomes an
 * uncaughtException that takes Pi down with it. That is exactly what happened after a
 * compaction closed the bridge and Cursor asked for one more blob.
 *
 * Hence two rules, both enforced here rather than at each of the dozen call sites:
 *   - once ended, the handle is not alive and silently drops writes;
 *   - every stream we own carries an error listener, so nothing the bridge does can ever
 *     surface as an uncaught exception in the host process.
 */

/** Length-prefix a frame the way the bridge process expects it. */
export function lpEncode(data) {
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.set(data, 4);
  return buf;
}
export function createBridgeHandle(proc, hooks = {}) {
  const debug = hooks.debug ?? (() => {});
  const cbs = {
    data: null,
    close: null
  };
  let exited = false;
  let closed = false;
  let ended = false;
  let exitCode = 1;

  // The safety net. A late write, a broken pipe, a bridge that could not be spawned at all —
  // none of them may reach the host's uncaughtException handler.
  proc.stdin?.on("error", error => {
    debug("bridge.stdin_error", {
      error: String(error)
    });
  });
  proc.stdout?.on("error", error => {
    debug("bridge.stdout_error", {
      error: String(error)
    });
  });
  proc.on("error", error => {
    debug("bridge.process_error", {
      error: String(error)
    });
  });
  let pending = Buffer.alloc(0);
  proc.stdout?.on("data", chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const len = pending.readUInt32BE(0);
      if (pending.length < 4 + len) break;
      const payload = pending.subarray(4, 4 + len);
      pending = pending.subarray(4 + len);
      cbs.data?.(Buffer.from(payload));
    }
  });
  proc.on("exit", () => { exited = true; });
  // close follows stdout drainage and also occurs after a failed spawn with no exit.
  proc.on("close", code => {
    exited = true;
    closed = true;
    exitCode = code ?? 1;
    debug("bridge.exit", {
      exitCode
    });
    hooks.onClose?.(exitCode);
    cbs.close?.(exitCode);
  });
  const writable = () => {
    if (exited || ended) return false;
    const stdin = proc.stdin;
    if (!stdin) return false;
    return !stdin.writableEnded && !stdin.destroyed;
  };
  const end = () => {
    if (ended) return;
    if (writable()) {
      try {
        proc.stdin.write(lpEncode(new Uint8Array(0)));
        proc.stdin.end();
      } catch (error) {
        debug("bridge.end_failed", {
          error: String(error)
        });
      }
    }
    ended = true;
  };
  return {
    proc,
    // Ended counts as dead: a caller that asks `alive` is deciding whether to keep talking on
    // this pipe, and the answer for a pipe we closed ourselves is no.
    get alive() {
      return !exited && !ended;
    },
    write(data) {
      if (!writable()) {
        debug("bridge.write_after_end", {
          bytes: data.length,
          exited,
          ended
        });
        return;
      }
      try {
        proc.stdin.write(lpEncode(data));
      } catch (error) {
        debug("bridge.write_failed", {
          error: String(error)
        });
      }
    },
    end,
    destroy() {
      end();
      if (exited) return;
      try {
        proc.kill();
      } catch (error) {
        debug("bridge.kill_failed", {
          error: String(error)
        });
      }
    },
    onData(cb) {
      cbs.data = cb;
    },
    onClose(cb) {
      if (closed) {
        queueMicrotask(() => cb(exitCode));
      } else {
        cbs.close = cb;
      }
    }
  };
}
