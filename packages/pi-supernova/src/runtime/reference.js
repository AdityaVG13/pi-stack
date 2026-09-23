// Standing tool description: sent on every request. No result or history compression.
export const REFERENCE = `JS body/async arrow; read/write/edit/bash, no fs/import/require. file: workspace JS; data: literals ≤48000 JSON chars.
read(path|paths,offset=1,limit?) → text/text[]; dirs→entries; PNG/JPEG/GIF/WebP ≤16/20MiB.
Text ≤64 MiB internally; complete:true requires whole file. Display capped: summarize or read(path,{offset:1,limit:80}); larger files via bash.
read({path,json:true}) or json:".field" or json:[".a"] → JSON, no jq (16MiB input/64MiB selection). Values retain their types. selector is json's value; a leftover selector key folds.
read("symbol or question") = read({query,resolve:true}) → view; check status; view.text is a span. read(path,{about}) windows; read({query,evidence:true}) evidence; read({path,outline:true}) declarations.
write/edit workspace-only; external changes need separately authorized command. write(path,text) or {path,content,append:true}; after read edit or replace:true.
edit(path,oldText,newText) or {path,edits:[{oldText,newText}]}; unique exact match; numbered windows. edit(view,text) or edit(view,old,new). edit(async()=>{...}) checkpoint: no bash; merge/rollback+rethrow.
bash(command,{cwd?,timeoutMs?}) or {command,args}; nonzero throws. Outer timeout bounds foreground; bash inherits. Shell mutations flush edits.
bash({command,background:true,pty?:true,timeoutMs?:1800000})→sessionId. bash({action:"list"}) or {sessionId,action:"poll"|"write"|"stop",cursor?,waitMs?,input?}→status/output/cursor/exitCode. PTY macOS/Linux; jobs end at shutdown.
programs:[{code?,file?,data?}] inherit defaults; mergeData:true shallow. Fresh guests/commits; sequential failure stops, prior commits stay; parallel:true disjoint work.
Promise.all ≤8 disjoint reads/mutations; same-file serial; bash/checkpoints barriers. Optional reads: Promise.allSettled retains successes. ONE call for known work.
`;
