import {parse} from 'acorn';
import {isObject,isString} from '../shared/decode.js';
import {guestImportMessage,isDeniedGuestImport} from './guest-deny-imports.js';

const PARSE_OPTIONS = { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function hasReturn(node) {
  if (!isObject(node)) return false;

  if (node.type === "ReturnStatement") return true;

  if (FUNCTION_TYPES.has(node.type)) return false;

  return Object.values(node).some(value => Array.isArray(value) ? value.some(hasReturn) : hasReturn(value));
}

function parseExpressionFunction(code) {
  try {
    const program = parse(code, PARSE_OPTIONS);
    const statements = program.body.filter(node => node.type !== "EmptyStatement");
    const statement = statements.length === 1 ? statements[0] : undefined;
    const candidate = statement?.type === "ExpressionStatement" ? statement.expression : statement;

    if (candidate && FUNCTION_TYPES.has(candidate.type)) {
      return { program, expression: candidate, expressionSource: code.slice(statement.start, statement.end).replace(/;\s*$/, "") };
    }

    return { program };
  } catch (bodyError) {
    const expressionSource = code.trimEnd().replace(/;+\s*$/, "");

    try {
      const wrapped = parse("(" + expressionSource + "\n)", PARSE_OPTIONS);
      const expression = wrapped.body[0]?.expression;

      if (!expression || !FUNCTION_TYPES.has(expression.type)) throw bodyError;

      return { expression, expressionSource };
    } catch { throw bodyError; }
  }
}

function deniedSpecifier(node) {
  if (node?.type === "Literal" && isString(node.value)) return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value?.cooked;
}

function assertGuestImports(node) {
  if (Array.isArray(node)) { node.forEach(assertGuestImports); return; }
  if (!isObject(node)) return;
  if (["ImportDeclaration", "ImportExpression"].includes(node.type)) rejectGuestImport(node.source);
  if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") rejectGuestImport(node.arguments?.[0]);
  for (const key of Object.keys(node)) {
    if (!["start", "end", "loc", "range"].includes(key)) assertGuestImports(node[key]);
  }
}

function prepareProgram(code) {
  const parsed = parseExpressionFunction(code);
  assertGuestImports(parsed.program ?? parsed.expression);
  const body = parsed.expression ? "return await (" + parsed.expressionSource + "\n)();" : code;
  const returns = parsed.expression
    ? parsed.expression.type === "ArrowFunctionExpression" && parsed.expression.body.type !== "BlockStatement" || hasReturn(parsed.expression.body)
    : hasReturn(parsed.program);

  return { body, hasReturn: returns };
}

function admitData(data, cap) {
  if (data === undefined) return { data };

  try {
    const encoded = JSON.stringify(data);

    if (encoded === undefined) return { error: "data must be JSON-serializable" };
    if (encoded.length > cap) return { error: "data exceeds " + cap + " characters (serialized JSON: " + encoded.length + " UTF-16 characters); no commands ran. Split literal inputs across invocations; large text can use write({path,content,append:true}) chunks without omitting content" };

    return { data: JSON.parse(encoded) };
  } catch { return { error: "data must be JSON-serializable" }; }
}

function admitCode({ code, file, cap }) {
  if ((code === undefined) === (file === undefined)) return { error: "supply exactly one of code or file; no commands ran" };
  if (file === undefined && (!isString(code) || !code.trim())) return { error: "code must be a non-empty string" };
  if (file === undefined && code.length > cap) return { error: "code exceeds " + cap + " characters; split large writes into write({path,content,append:true}) chunks" };
}

function admitTimeout(config) {
  const requestedTimeout = Number(config.timeoutMs === undefined ? 60000 : config.timeoutMs);

  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) return { error: "timeoutMs must be a positive finite number" };

  return { timeoutMs: Math.max(1, Math.min(2_147_483_647, Math.floor(requestedTimeout))) };
}

function admitGuest({ code, file, data, config }) {
  const cap = config.maxCodeChars ?? 48000;
  const codeError = admitCode({ code, file, cap });

  if (codeError) return codeError;
  const admitted = admitData(data, cap);

  if (admitted.error) return admitted;
  const timeout = admitTimeout(config);

  if (timeout.error) return timeout;

  return { data: admitted.data, timeoutMs: timeout.timeoutMs };
}
export { admitGuest, prepareProgram };

function rejectGuestImport(source) {
  const spec = deniedSpecifier(source);
  const reason = spec && isDeniedGuestImport(spec) ? guestImportMessage(spec) : "guest cannot import modules; use read, edit, write, or bash";
  throw new Error(reason + "; no commands ran");
}

function containingAwait(node, offset) {
  if (Array.isArray(node)) return node.map(child => containingAwait(child, offset)).find(Boolean);
  if (!isObject(node) || offset < node.start || offset >= node.end) return null;
  for (const child of Object.values(node)) {
    const found = containingAwait(child, offset);
    if (found) return found;
  }
  return node.type === "AwaitExpression" ? node : null;
}

// V8 points at 'await'; JSC points at the called function's parenthesis. Report
// the enclosing await expression consistently, using source syntax, not offsets.
export function normalizeGuestLocation(source, location) {
  if (!location?.awaited) return location;
  const {line, col} = location;
  const prefix = source.split("\n").slice(0, line - 1).join("\n");
  const offset = prefix.length + Number(line > 1) + col - 1;
  try {
    const node = containingAwait(parse(source, {...PARSE_OPTIONS, locations:true}), offset);
    return node ? {line:node.loc.start.line, col:node.loc.start.column + 1} : location;
  } catch { return location; }
}
