// Standing tool description: sent on every request. One nova call, four commands inside.
export const REFERENCE = `JavaScript async body or arrow with read, write, edit, bash. file rereads that program. Put Markdown/scripts/argv in data. Guest has no fs/import/require; bash mutates but never reads files.

read(path|paths, offset?, limit?) → raw text or text[]; read(directory) → entries[]
read(imagePath) → image (PNG/JPEG/GIF/WebP/BMP)
read({path,json:".field"}) → parsed JSON; .items[0:3], .items.length, quoted keys, or true; 16 MiB cap; no jq
raw JSON over the bound returns {status:"too_large",path,keys} (length for top-level arrays); project it with json:".field"
read("symbol or question") → same view as resolve:true
read({query,resolve:true}) → {status,path,line,text,...}
read(path,{about}) → matching windows; read({query,evidence:true}) → ranked evidence; read({path,outline:true}) → declarations
write(path, text) → replace an unread file; write({path,content,append:true}) → append without a prior read. After read use edit; replace:true overrides.
edit(path,oldText,newText) | edit({path,edits}) → numbered post-edit lines, checks, references
edit(async () => {...}) → checkpoint: commit on success, rollback on throw
bash(command,{cwd?,timeoutMs?}) → bounded output; nonzero throws
bash({command,args}) → literal argv

edit oldText is an exact substring of read(); a miss includes a numbered window. Found is a span, not the file. Check resolve:true status; edit(view,text) replaces that window; edit(view,old,new) is unique inside it. complete:true rejects partial files. Array reads reject failures. Edits stage until success; bash commits preceding writes. Batch known reads, edits, and tests in this program (Promise.all, or programs with parallel:true).
programs:[{code|file,data?},...] sequential fresh guests, separate commits; top-level data defaults per entry. Stop on failure keeps earlier commits. parallel:true runs disjoint entries concurrently. Separate supernova calls only when the next step needs a model decision.
`;
