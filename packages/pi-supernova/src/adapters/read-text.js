import {isString,isNumber} from '../shared/decode.js';
import {WorkspaceIndex} from '../context/repo-index.js';
import {pickSpan} from '../context/spans.js';
import {outlineFile} from '../context/outline.js';
import {readResult} from '../shared/result.js';
import {sliceLinesRaw,sourceLines,contentLineInfo} from '../fs/lines.js';
import {LARGE_FILE_BYTES,TEXT_MAX_BYTES} from './errors.js';
import {outlineOptions,recordOutlineOrigins,createReferenceFinder} from './refs.js';

function needsSourceIndex(params,query) {
  return isString(params.about) || (params.resolve && isString(query));
}

export function createTextReader(ctx, readWindow) {
  const {getCwd,vfs,config,index,ledger}=ctx;
  const referenceFinder=createReferenceFinder(index,vfs);

  async function loadText(targetPath, params, query, signal) {
    const explicit = isNumber(params.offset) || isNumber(params.limit);
    const windowed = explicit && params.complete !== true && !isString(params.about) && !isString(query);
    if (!windowed) {
      // Whole reads hash the bytes already loaded. Do not read once for a window
      // and open/hash the entire file a second time just to return the same text.
      return {text:await vfs.read(targetPath,{maxBytes:TEXT_MAX_BYTES}),windowed:false};
    }
    const start = isNumber(params.offset) ? Math.max(1,Math.floor(params.offset)) : 1;
    const count = isNumber(params.limit) ? Math.max(0,Math.floor(params.limit)) : undefined;
    const window = await readWindow(targetPath,start,count,TEXT_MAX_BYTES,signal);
    if (!window.satisfied) throw new Error("read window exceeds " + TEXT_MAX_BYTES + " bytes: " + targetPath + "; request fewer lines or use a bounded parser through bash");
    return {text:window.text,windowed:true,windowWhole:window.whole};
  }

  async function maybeOutline(cwd, rel, targetPath, text, params, entry) {
    if (!isString(params.about)) return null;
    const outline = entry && outlineFile(entry,rel,params.about,outlineOptions(params,await referenceFinder(cwd,targetPath),config));
    if (!outline) return null;
    recordOutlineOrigins(ledger,rel,outline.text);
    return readResult(outline.text,{path:targetPath,outline:true,expanded:outline.expanded,declarations:outline.declarations});
  }

  function resolveSpan(entry, sourceLine, query, params) {
    if (!params.resolve || !isString(query) || !entry) return {offset:params.offset,limit:params.limit,viewComplete:undefined};
    const span=pickSpan(WorkspaceIndex.spansOf(entry),{line:sourceLine,name:query});
    if (!span) return {offset:params.offset,limit:params.limit,viewComplete:undefined};
    const spanLines=span.end-span.start+1;
    const limit=isNumber(params.limit) ? Math.min(params.limit,spanLines) : spanLines;
    return {offset:span.start,limit,viewComplete:limit>=spanLines};
  }

  function textFileResult(rel,targetPath,loaded,span,sliced,firstLine,explicit) {
    const lines=sliced.length<=LARGE_FILE_BYTES ? sourceLines(sliced) : null;
    if (lines) ledger.recordOrigin(rel,firstLine,lines,explicit);
    return readResult(sliced,{path:targetPath,firstLine,lastLine:firstLine+(lines?.length ?? contentLineInfo(sliced).count)-1,
      sourceChars:sliced.length,complete:loaded.windowed ? loaded.windowWhole : sliced===loaded.text,viewComplete:span.viewComplete});
  }

  async function readTextFile(targetPath,params,sourceLine,rel,query,signal) {
    const explicit=isNumber(params.offset)||isNumber(params.limit);
    const loaded=await loadText(targetPath,params,query,signal);
    index.touch(rel);
    const entry=needsSourceIndex(params,query) ? WorkspaceIndex.fromText(targetPath,loaded.text) : null;
    const outlined=await maybeOutline(getCwd(),rel,targetPath,loaded.text,params,entry);
    if (outlined) return outlined;
    const span=resolveSpan(entry,sourceLine,query,params);
    const firstLine=isNumber(span.offset) ? Math.max(1,Math.floor(span.offset)) : 1;
    const sliced=loaded.windowed ? loaded.text : sliceLinesRaw(loaded.text,span.offset,span.limit);
    if (params.complete===true && sliced!==loaded.text) throw new Error("complete:true requires the whole file; remove offset/limit for " + rel);
    return textFileResult(rel,targetPath,loaded,span,sliced,firstLine,explicit);
  }
  return readTextFile;
}
