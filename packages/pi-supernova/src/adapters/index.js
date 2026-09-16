import { createNativeScheduler } from "../runtime/parallel.js";
import { createRead } from "./read.js";
import { createWrite } from "./write.js";
import { createEdit } from "./edit.js";
import { createBash } from "./bash.js";
import { createList } from "./list.js";

export function createNativeAdapters(getCwd, vfs, config, index, ledger, hooks) {
  const ctx = { getCwd, vfs, config, index, ledger, hooks, reads: createNativeScheduler() };
  const read = createRead(ctx);
  ctx.readDirectory = read.readDirectory;
  const write = createWrite(ctx);
  const edit = createEdit(ctx);
  const bash = createBash(ctx);
  const list = createList(ctx);
  hooks.summarizeEdit = edit.editSummary;
  return {
    read: read.read,
    write: write.write,
    edit: edit.edit,
    apply_patch: edit.apply_patch,
    snap: read.snap,
    evidence: read.evidence,
    surface: read.surface,
    bash: bash.bash,
    grep: list.grep,
    glob: list.glob,
    find: list.find,
    ls: list.ls,
  };
}
