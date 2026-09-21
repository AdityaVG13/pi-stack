import {isString} from '../shared/decode.js';
import {truncateChars,formatBoundedStringArray,isStringArray} from './format.js';

function result(text, details) {
  return { content: [{ type: "text", text }], details };
}

function logsBlock(outcome, tail = "") {
  if (!outcome.logs?.length && !outcome.logTruncated) return "";

  return `\n--- logs${outcome.logTruncated ? " [logs truncated]" : ""}\n${outcome.logs?.join("\n") ?? ""}${tail}`;
}

function mutationText(outcome) {
  const m = outcome.mutations;

  if (!m) return "";
  const external = m.external ? "; external calls attempted=" + m.external + ", their side effects cannot be rolled back" : "";
  const uncertain = m.pendingCommits || m.recoveryFailed ? "; filesystem outcome uncertain: inspect disk and any recovery backups before retrying" : "";

  return "\nmutations: committed=" + m.committed + " rolledBack=" + m.rolledBack + " (file versions)" + external + uncertain;
}

function mutationReceipts(trace) {
  if (!Array.isArray(trace)) return "";

  return trace
    .filter(row => row?.ok && (row.name === "write" || row.name === "edit") && isString(row.resultText) && row.resultText)
    .map(row => row.resultText)
    .join("\n");
}

// Corrective hint, emitted only when a turn actually split. Independent work
// belongs in one program: a split cannot use the single prewarmed worker and pays
// one extra spawn per sibling. Costs nothing until it fires, so it needs no room in
// the tool definition.
function splitTurnHint(outcome) {
  return outcome.overlappedTurn ? ` (${outcome.overlappedTurn} supernova calls ran at once; independent work belongs in one program)` : "";
}

function errorText(outcome, call) {
  return `error #${call} ${outcome.wallMs}ms${outcome.returnTruncated ? " [output truncated]" : ""}${mutationText(outcome)}${splitTurnHint(outcome)}
error: ${outcome.error}${logsBlock(outcome)}`;
}

function successText(outcome, call) {
  const truncated = outcome.returnTruncated ? " [return truncated]" : "";
  const hint = outcome.undefinedReturn ? " (no return statement; add `return` to get a value)" : "";
  const m = outcome.mutations;
  const showMutations = m && (m.committed || m.rolledBack || m.external || m.pendingCommits || m.recoveryFailed) ? mutationText(outcome) : "";

  return `ok #${call} ${outcome.wallMs}ms${truncated}${showMutations}${splitTurnHint(outcome)}${logsBlock(outcome, "\n--- result")}\n${outcome.resultText}${hint}`;
}

function fitOutput(outcome, call, limit, format) {
  let text = format(outcome, call);

  if (text.length <= limit) return text;
  outcome.returnTruncated = true;
  const wrapper = format({ ...outcome, resultText: "", logs: [] }, call);
  const room = Math.max(256, limit - wrapper.length);

  if (isStringArray(outcome.result)) {
    outcome.resultText = formatBoundedStringArray(outcome.result, room);
  } else if (isString(outcome.resultText) && outcome.resultText.length > room) {
    outcome.resultText = truncateChars(outcome.resultText, room, "output").text;
  }

  text = format(outcome, call);

  return text.length <= limit ? text : truncateChars(text, limit, "output").text;
}

function attachReceipts(outcome, trace) {
  if (outcome.ok && outcome.result === undefined) {
    const receipts = mutationReceipts(trace);

    if (receipts) {
      outcome.resultText = receipts;
      outcome.undefinedReturn = false;
    }
  }
}

function throwIfFailed(outcome, visible, response) {
  if (outcome.ok) return response;
  const error = new Error(visible);
  Object.defineProperty(error,"supernovaResult",{value:response});
  throw error;
}
export { result, errorText, successText, fitOutput, attachReceipts, throwIfFailed };
