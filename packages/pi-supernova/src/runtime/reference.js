// Standing tool description: sent on every request. No result or history compression.
export const REFERENCE = `JS body/async arrow with read/write/edit/bash; no fs/import/require. file runs workspace scripts. data holds literal text/scripts/argv (≤48000 serialized JSON chars).
read(path|paths,offset=1,limit?) → raw text/text[]; directories → entries; images: PNG/JPEG/GIF/WebP (≤16 attachments/20 MiB total).
Path-only: ≤160 lines AND 8192 characters (UTF-16). Use read(path,{offset:1,limit:80}), about, or complete:true (whole file ≤31744 chars). Large JSONL: bounded parser via bash.
read({path,json:selector}) → parsed JSON; selectors ".field", ".a[0:3]", ".a.length", quoted keys, true; 16 MiB input, no jq. Oversized → {status:"too_large",keys} (arrays: length); narrow selectors.
read("symbol or question") = read({query,resolve:true}) → view; check status; view.text is a span, not the file.
read(path,{about}) → windows; read({query,evidence:true}) → ranked evidence; read({path,outline:true}) → declarations.
write(path,text) replaces unread workspace files; write({path,content,append:true}) appends without reading. After read: edit or replace:true.
edit(path,oldText,newText) | edit({path,edits:[{oldText,newText}]}) exact unique read text; numbered windows (including misses), checks/references.
edit(view,text) replaces the span; edit(view,old,new) matches uniquely within it. edit(async()=>{...}) checkpoint merges on success, rolls back/rethrows on failure; catch to recover.
bash(command,{cwd?,timeoutMs?}) | bash({command,args}) literal argv; bounded output, nonzero throws; inherits program timeout unless overridden.
Edits stage until success; bash commits first. Array errors abort; Promise.allSettled for optional reads.
programs:[{code?,file?,data?}] inherits top-level code OR file and data. Entry source overrides; data replaces unless mergeData:true (shallow objects, entry keys win).
Fresh guests/separate commits; sequential failure stops, prior commits stay. parallel:true for disjoint entries. Batch known work; separate calls only for new decisions.
`;
