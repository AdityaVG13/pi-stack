// Standing tool description: sent on every request. No result or history compression.
export const REFERENCE = `JS body/async arrow: read/write/edit/bash; no fs/import/require. file: workspace scripts; data: literals (≤48000 JSON chars).
read(path|paths,offset=1,limit?) → raw text/text[]; directories → entries; images: PNG/JPEG/GIF/WebP (≤16 images/20 MiB).
Text ≤64 MiB internally; complete:true requires the whole file. Display alone is capped; return a summary or read(path,{offset:1,limit:80}). Larger files/JSONL: bounded bash parser.
read({path,json:selector}) → parsed JSON: ".field", ".a[0:3]", ".a.length", quoted keys, true; input ≤16 MiB, selections ≤64 MiB storage, no jq. Values retain their types.
read("symbol or question") = read({query,resolve:true}) → view; check status; view.text is a span, not the file.
read(path,{about}) → windows; read({query,evidence:true}) → ranked evidence; read({path,outline:true}) → declarations.
write(path,text) replaces unread workspace files; write({path,content,append:true}) appends without reading. After read: edit or replace:true.
edit(path,oldText,newText) | edit({path,edits:[{oldText,newText}]}) unique exact read text; returns numbered windows/checks/references.
edit(view,text) replaces span; edit(view,old,new) uniquely matches within it. edit(async()=>{...}) checkpoint: merge on success, rollback/rethrow on failure.
bash(command,{cwd?,timeoutMs?}) | bash({command,args}) literal argv for scripts; bounded output, nonzero throws. Outer timeoutMs caps ALL waits/commands; bash inherits unless overridden.
Edits commit on success/before bash. Promise.allSettled keeps partial results.
programs:[{code?,file?,data?}] inherits source/data; entries override. mergeData:true shallow object merge (entry keys win).
Promise.all: ≤8 reads or disjoint-file mutations; same-file serial; bash/checkpoint barriers.
Fresh guests/separate commits. Sequential failure stops; prior commits stay. parallel:true for disjoint entries. ONE call for known work; split for new decisions.
`;
