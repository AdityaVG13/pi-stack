// Standing tool description: sent on every request. No result or history compression.
export const REFERENCE = `JS body/async arrow: read/write/edit/bash; no fs/import/require. file: workspace scripts; data: literals (≤48000 JSON chars).
read(path|paths,offset=1,limit?) → raw text/text[]; directories → entries; images: PNG/JPEG/GIF/WebP (≤16 images/20 MiB).
Path-only ≤160 lines AND 8192 characters (UTF-16); larger: read(path,{offset:1,limit:80}), about, or complete:true (whole file ≤31744 chars). Large JSONL: bounded bash parser.
read({path,json:selector}) → parsed JSON: ".field", ".a[0:3]", ".a.length", quoted keys, true; ≤16 MiB, no jq. {status:"too_large",keys|length} → narrow selector.
read("symbol or question") = read({query,resolve:true}) → view; check status; view.text is a span, not the file.
read(path,{about}) → windows; read({query,evidence:true}) → ranked evidence; read({path,outline:true}) → declarations.
write(path,text) replaces unread workspace files; write({path,content,append:true}) appends without reading. After read: edit or replace:true.
edit(path,oldText,newText) | edit({path,edits:[{oldText,newText}]}) unique exact read text; returns numbered windows/checks/references.
edit(view,text) replaces span; edit(view,old,new) uniquely matches within it. edit(async()=>{...}) checkpoint: merge on success, rollback/rethrow on failure.
bash(command,{cwd?,timeoutMs?}) | bash({command,args}) literal argv for scripts; bounded output, nonzero throws. Outer timeoutMs caps ALL waits/commands; bash inherits unless overridden.
Edits stage until success; bash commits first. Array errors abort; Promise.allSettled for optional reads.
programs:[{code?,file?,data?}] inherits code OR file and data. Entries override source/data; mergeData:true shallow-merges objects (entry keys win).
Fresh guests/separate commits; sequential failure stops, prior commits stay. parallel:true for disjoint entries. Batch known reads/checks (Promise.all) + edits/verification in ONE call; split for new decisions.
`;
