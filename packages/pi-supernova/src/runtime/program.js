import {parse} from 'acorn';
import {isObject,isString} from '../shared/decode.js';
import {guestImportMessage,isDeniedGuestImport} from './guest-deny-imports.js';

const PARSE_OPTIONS = { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function parseExpressionFunction(code) {
  try {
    const program = parse(code, PARSE_OPTIONS);
    const statements = program.body.filter(node => node.type !== "EmptyStatement");
    const statement = statements.length === 1 ? statements[0] : undefined;
    const candidate = statement?.type === "ExpressionStatement" ? statement.expression : statement;

    if (candidate && FUNCTION_TYPES.has(candidate.type)) {
      return { program, expression: candidate, sourceStart: statement.start, expressionSource: code.slice(statement.start, statement.end).replace(/;\s*$/, "") };
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

function inspectProgram(root, expression) {
  let returns = expression?.type === "ArrowFunctionExpression" && expression.body.type !== "BlockStatement";
  // Valid member chains can exceed the host call stack well below the code cap.
  const pending = [{node:root,returnScope:true}];

  while (pending.length) {
    let {node,returnScope} = pending.pop();

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) pending.push({node:node[i],returnScope});

      continue;
    }

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- This is an Acorn-owned AST, not unparsed host or guest data.
    if (!node || typeof node !== "object") continue;
    const type = node.type;

    // Function scopes affect only return hints. Import checks must still visit
    // nested/unreachable bodies, even after finding a return in the invoked scope.
    if (FUNCTION_TYPES.has(type)) returnScope = node === expression;

    if (type === "ReturnStatement" && returnScope) returns = true;

    if (type === "ImportDeclaration" || type === "ImportExpression") rejectGuestImport(node.source);

    if (type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") rejectGuestImport(node.arguments?.[0]);

    const keys = Object.keys(node);

    for (let i = keys.length - 1; i >= 0; i--) {
      const value = node[keys[i]];

      // eslint-disable-next-line anti-slop/no-runtime-typeof -- Acorn already parsed these fields; distinguish child objects from scalar AST metadata.
      if (value && typeof value === "object") pending.push({node:value,returnScope});
    }
  }

  return returns;
}

function prepareProgram(code) {
  const parsed = parseExpressionFunction(code);
  const returns = inspectProgram(parsed.program ?? parsed.expression, parsed.expression);
  const body = parsed.expression ? "return await (" + parsed.expressionSource + "\n)();" : code;

  return { body, hasReturn: returns, sourceStart: parsed.sourceStart ?? 0, prefixLength: parsed.expression ? "return await (".length : 0 };
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

function containingAwait(root, offset) {
  const pending = [root];
  let found = null;

  while (pending.length) {
    const node = pending.pop();

    if (Array.isArray(node)) {
      for (const child of node) pending.push(child);

      continue;
    }

    if (!isObject(node) || offset < node.start || offset >= node.end) continue;

    // Containing awaits nest; descendants supersede the enclosing await.
    if (node.type === "AwaitExpression") found = node;

    for (const child of Object.values(node)) pending.push(child);
  }

  return found;
}

// V8 points at 'await'; JSC points at the call parenthesis. Resolve the await
// in executable syntax, then undo wrapper/sliced-comment offsets. ECMAScript
// line separators differ from file/JSONL LF framing.
export function normalizeGuestLocation(source, location, prepared = { body: source }) {
  if (!location) return location;
  const body = prepared.body;
  const lines = /\r\n|[\n\r\u2028\u2029]/g;
  let start = 0;

  for (let line = 1; line < location.line; line++) {
    if (!lines.exec(body)) return null;
    start = lines.lastIndex;
  }

  let offset = start + location.col - 1;

  if (location.awaited) {
    try { offset = containingAwait(parse(body, PARSE_OPTIONS), offset)?.start ?? offset; }
    catch { /* Keep the engine's position when syntax cannot be recovered. */ }
  }

  offset += (prepared.sourceStart ?? 0) - (prepared.prefixLength ?? 0);

  if (offset < 0 || offset > source.length) return null;
  const original = source.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/);

  return { ...location, line: original.length, col: original.at(-1).length + 1 };
}
