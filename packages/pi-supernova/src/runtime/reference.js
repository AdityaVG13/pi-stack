// Standing tool description: sent on every request. One nova call, four commands inside.
export const REFERENCE = `JavaScript async body or arrow with read, write, edit, bash. Exactly one of code or file; file rereads that program (same limits, cwd, fresh guest). Put Markdown/scripts/argv in data. Guest has no fs/child_process/import/require; bash mutates but never reads workspace files (no cat/head/sed/tee).

read(path|paths, offset?, limit?) → raw text or text[]; read(directory) → entries[]; up to 64 paths
read(imagePath) → image (PNG/JPEG/GIF/WebP/BMP); 20 MiB max, 16 attachments max
read({path,json:".field"}) → parsed JSON; .items[0:3], .items.length, quoted keys, 1-64 selectors, or true; 16 MiB cap; no jq
raw JSON over the bound returns {status:"too_large",path,keys} (length for top-level arrays); project it with json:".field"
read("symbol or question") → same view as resolve:true; source questions use at most 16 keywords
read({query,resolve:true}) → {status,path,line,lines,text,complete,nextOffset?}
read(path,{about}) → matching windows; read({query,evidence:true}) → ranked evidence; read({path,outline:true}) → declarations
write(path, text) → replace an unread file; write({path,content,append:true}) → append without a prior read. After read use edit; replace:true overrides.
edit(path,oldText,newText) | edit({path,edits}) | edit({path,patch}) → numbered post-edit lines, checks, references
edit(async () => {...}) → checkpoint: commit on success, rollback on throw; no shell, nesting, or outside commands
bash(command,{cwd?,timeoutMs?}) → bounded output; nonzero throws
bash({command,args}) → literal argv, no shell expansion of args

edit oldText is an exact substring of read(); a miss includes a numbered window. Found is a span, not the file; uncertain returns ambiguous, not_found, or incomplete. Check resolve:true status; edit(view,text) replaces that window; edit(view,old,new) is unique inside it. complete:true rejects partial files. Array reads reject failures; Promise.allSettled for per-path outcomes. Edits stage until success; bash commits preceding writes. When the next reads, edits, and test are already known, do them in this program (Promise.all, or programs with parallel:true).
programs:[{code|file,data?},...] sequential fresh guests, separate commits; top-level data defaults per entry, entry data overrides. Stop on failure keeps earlier commits. parallel:true runs independent disjoint-path entries concurrently. Separate supernova calls only when the next step needs a model decision.`;
