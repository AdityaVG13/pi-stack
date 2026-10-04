import { isString, isObject, isFunction, isNumber } from "../shared/decode.js";

export const EDIT_USAGE = 'invalid edit signature; use edit(path,oldText,newText), edit(path,{oldText,newText}), edit({path,edits:[{oldText,newText}]}), or edit({path,patch:"@@ -1 +1 @@\n-old\n+new\n"})';

function spanStart(value) {
  return isNumber(value.start) ? value.start : Array.isArray(value.lines) ? value.lines[0] : value.line;
}

function spanEnd(value, start) {
  return isNumber(value.end) ? value.end : Array.isArray(value.lines) && value.lines.length > 1 ? value.lines[1] : start;
}

export function viewSpan(value) {
  const start = spanStart(value);
  const end = spanEnd(value, start);

  if (!isNumber(start) || !isNumber(end) || start < 1 || end < start) return null;

  return { start: Math.floor(start), end: Math.floor(end) };
}

export function isEditView(value) {
  return isObject(value) && !Array.isArray(value) && isString(value.path) && value.path.length > 0 && isString(value.text) && (value.status === undefined || value.status === "found") && viewSpan(value);
}

function classifyViewEdit(p, oldText, newText) {
  if (isNumber(p.nextOffset)) throw new Error("edit view is incomplete");
  const span = viewSpan(p);
  const args = { path: p.path, viewStart: span.start, viewEnd: span.end, viewText: p.text, newText: newText === undefined ? oldText : newText };

  if (newText !== undefined) args.oldText = oldText;

  return { kind: "view", command: "edit", args };
}

function namedEditObject(p, oldText, newText) {
  if (isObject(p) && (Array.isArray(p) || oldText !== undefined || newText !== undefined)) throw new Error(EDIT_USAGE);

  return p;
}

function namedEditPositional(p, oldText, newText) {
  if (Array.isArray(oldText)) return { path: p, edits: oldText };

  if (isObject(oldText)) {
    // edit(path,{oldText,newText}|{edits}|{patch}): the path rides in either
    // argument, but a conflicting path or third argument is still rejected.
    if (newText !== undefined || (oldText.path !== undefined && oldText.path !== p)) throw new Error(EDIT_USAGE);

    return { ...oldText, path: p };
  }

  return { path: p, oldText, newText };
}

function normalizeEditArgs(p, oldText, newText) {
  return isObject(p) ? namedEditObject(p, oldText, newText) : namedEditPositional(p, oldText, newText);
}

function namedEditArgs(p, oldText, newText) {
  const args = normalizeEditArgs(p, oldText, newText);

  if (!isString(args.path) || args.path.length === 0) throw new Error(EDIT_USAGE);

  return args;
}

function assertNamedEditMode(args, oldText, newText) {
  const modes = Number(args.patch !== undefined) + Number(args.edits !== undefined) + Number(args.oldText !== undefined || args.newText !== undefined);

  if (modes !== 1 || (Array.isArray(oldText) && newText !== undefined)) throw new Error(EDIT_USAGE);
}

function classifyPatch(args) {
  if (!isString(args.patch) || !args.patch.trim()) throw new Error(EDIT_USAGE);

  return { kind: "patch", command: "apply_patch", args };
}

function classifyReplacements(args) {
  const edits = args.edits === undefined ? [args] : args.edits;

  if (!Array.isArray(edits) || !edits.length) throw new Error(EDIT_USAGE);

  for (const [i, edit] of edits.entries()) {
    if (!validReplacement(edit)) throw new Error(replacementError(edit));

    if (args.edits !== undefined) assertEditOptions(edit, REPLACEMENT_OPTION_KEYS, "edit " + (i + 1) + " of " + edits.length);
  }

  return { kind: "edits", command: "edit", args };
}

function validReplacement(edit) {
  return isString(edit?.oldText) && !!edit.oldText.length && isString(edit?.newText);
}

function replacementError(edit) {
  return EDIT_USAGE + "; replacements require non-empty oldText and string newText" + (isString(edit?.oldText) && !edit.oldText.length ? "; to insert, include adjacent existing text in oldText and repeat it in newText" : "");
}

const EDIT_OPTION_KEYS = ["path", "oldText", "newText", "edits", "patch"];

const REPLACEMENT_OPTION_KEYS = ["oldText", "newText"];

/** A view object carries host fields; only named replacements are validated. */
function assertEditOptions(args, allowed = EDIT_OPTION_KEYS, label = "edit") {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key));

  if (unknown.length) throw new Error(label + " does not accept option " + unknown.map(key => JSON.stringify(key)).join(", ") + "; supported options are " + allowed.join(", "));
}

function classifyNamedEdit(p, oldText, newText) {
  const args = namedEditArgs(p, oldText, newText);
  assertNamedEditMode(args, oldText, newText);
  assertEditOptions(args);

  return args.patch !== undefined ? classifyPatch(args) : classifyReplacements(args);
}

/** Guest signature → { command, args } for one host call. */
export function classifyEdit(p, oldText, newText) {
  if (isFunction(p)) {
    if (oldText !== undefined || newText !== undefined) throw new Error(EDIT_USAGE);

    return { kind: "checkpoint", fn: p };
  }

  if (isEditView(p) && isString(oldText) && (newText === undefined || isString(newText))) return classifyViewEdit(p, oldText, newText);

  return classifyNamedEdit(p, oldText, newText);
}
