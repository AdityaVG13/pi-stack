import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {isString} from '../shared/decode.js';

function contained(root, target) {
  const rel = path.relative(root,target);

  return rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);
}

function validHintPath(hint) {
  return isString(hint?.path) && !!hint.path && hint.path.isWellFormed() && !hint.path.includes('\0');
}

function validHintRange(hint) {
  return Number.isSafeInteger(hint.startLine) && Number.isSafeInteger(hint.endLine) &&
    hint.startLine >= 1 && hint.endLine >= hint.startLine && hint.endLine-hint.startLine < 40;
}

function assertScope(root, scope, target, message) {
  if (!contained(root,target) || !contained(scope,target)) throw new Error(message);
}

async function resolveHint(hint, cwd, scope, root, directory) {
  if (!validHintPath(hint) || !validHintRange(hint)) throw new Error('invalid indexed context range');
  let target = path.resolve(cwd,hint.path);

  if (!contained(cwd,target) || !contained(scope,target)) {
    // Providers may spell the same workspace with its realpath. Admit only
    // that canonical scope, then restore the caller's logical path for reads.
    assertScope(root,directory,target,'indexed context is outside the requested workspace scope');
    target = path.resolve(scope,path.relative(directory,target));
  }

  const real = await fs.realpath(target);
  assertScope(root,directory,real,'indexed context escapes workspace scope');

  return {path:target,line:hint.startLine,endLine:hint.endLine};
}

function contextHints(response) {
  const details = response?.details;

  if (response?.isError || details?.code !== 'OK' || details.timedOut) throw new Error('indexed search incomplete or unavailable; retry or omit indexed:true');
  const hints = details.contexts;

  if (!Array.isArray(hints) || hints.length > 8) throw new Error('invalid indexed context metadata');

  return {details,hints};
}

function sourceSelection(candidates, details, cwd) {
  if (candidates.length === 1 && (!details.truncated || details.contextSelectionComplete === true)) return {status:'found',...candidates[0]};

  return {status:candidates.length ? 'ambiguous' : 'not_found',path:null,line:null,context:candidates.map(c=>({...c,path:path.relative(cwd,c.path)})),message:'Narrow the indexed query or use an explicit path.'};
}

// Provider metadata is only a locator. The owned reader captures bytes and its
// CAS baseline itself; rendered text and sourceVersion are never trusted.
export async function indexedSource(hooks, query, cwd, scope, signal) {
  if (!hooks.indexedSearch) throw new Error('indexed read requires a callable isearch');
  signal?.throwIfAborted();
  const response = await hooks.indexedSearch({query,path:path.relative(cwd,scope)||'.',withContext:true,limit:2,budgetChars:8000});
  signal?.throwIfAborted();
  const {details,hints} = contextHints(response);
  const root = await fs.realpath(cwd), directory = await fs.realpath(scope);
  const candidates = [];

  for (const hint of hints) candidates.push(await resolveHint(hint,cwd,scope,root,directory));

  return sourceSelection(candidates,details,cwd);
}
