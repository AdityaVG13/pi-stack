// Standing tool description: sent on every request. No result or history compression.
export const REFERENCE = `JS body/async arrow; read/write/edit/bash, no fs/import/require. file: workspace JS; data: ≤48000 JSON chars.
read(path|paths,offset=1,limit?) → text/text[]; dirs→entries; PNG/JPEG/GIF/WebP ≤16/20MiB.
Text ≤64 MiB internally; complete:true whole file. Display capped: summarize or read(path,{offset:1,limit:80}); larger files via bash.
read({path,json:true}) → JSON; json:".field" or json:[".a"] selects (16MiB input/64MiB selection; no jq). Values retain their types; leftover selector folds into json.
read({query,indexed:true}): optional callable isearch, then an owned editable read.
read("symbol or question") = read({query,resolve:true}) → view; check status; view.text is a span. read(path,{about}) windows; read({query,evidence:true}) evidence; read({path,outline:true}) declarations.
write/edit workspace-only; external changes need separately authorized command. write(path,text,opts?) or {path,content,append:true}; after read edit or replace:true.
edit(path,oldText,newText) or {path,edits:[{oldText,newText}]}; unique exact match; numbered windows. edit(view,text) or edit(view,old,new). edit(async()=>{...}) atomic checkpoint: no bash; commit/rollback+rethrow. Other edits save; retry failures only.
bash(command,opts?) or {command,args,cwd?,timeoutMs?}; nonzero throws. Capture≤2Mi chars; larger output via file; outer deadline.
bash({command,background:true,pty?:true,timeoutMs?:1800000})→sessionId. bash({action:"list"}) or {sessionId,action:"poll"|"write"|"stop",cursor?,waitMs?,input?}→status/output/cursor/exitCode. poll waitMs 0..30000. PTY macOS/Linux; jobs end at shutdown.
programs:[{code?,file?,data?}] inherit defaults; mergeData:true shallow. Fresh guests; failures continue; limits/uncertainty stop; parallel:true disjoint.
Promise.all ≤8 disjoint; same-file serial; bash/checkpoints barriers. Independent: Promise.allSettled; uncaught errors stop JS.
`;
