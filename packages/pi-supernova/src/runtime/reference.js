// Complete model-facing API reference; kept in every request, not moved into history.
export const REFERENCE = `JavaScript async body or arrow with read, write, edit, bash. Strings stay raw. Exactly one of code or file; file rereads that program (same limits, cwd, fresh guest). Caps are UTF-16. Put Markdown/scripts/argv in data.

read(path|paths, offset?, limit?) → raw text or text[]; read(directory) → entries
read(imagePath) → image (PNG/JPEG/GIF/WebP/BMP)
read({path,json:".field"}) → parsed JSON; .items[0:3], quoted keys, selector arrays, or true; 16 MiB cap; no jq
read("agent://id?q=.answer") → JSON field from session artifacts
read("symbol or question") → same view as resolve:true
read({query,resolve:true}) → {status,path,line,lines,text,complete,nextOffset?}
read(path,{about}) → matching windows; read({query,evidence:true}) → ranked evidence; read({path,outline:true}) → declarations
write(path, text) → replace; write({path,content,append:true}) → append without a prior read
edit(path,oldText,newText) | edit({path,edits}) | edit({path,patch}) → numbered post-edit lines, checks, references
edit(async () => {...}) → checkpoint: commit on success, rollback on throw; no shell, nesting, or outside commands
bash(command,{cwd?,timeoutMs?}) → bounded output; nonzero throws
bash({command,args}) → literal argv, no shell expansion of args

edit oldText is an exact substring of read(); a miss includes a numbered window. Found is a span, not the file; uncertain returns ambiguous, not_found, or incomplete. Check resolve:true status; edit(view,text) replaces that window; edit(view,old,new) is unique inside it. complete:true rejects partial files; use about or offset/limit for large audits. Array reads reject failures; Promise.allSettled for per-path outcomes. Edits stage until success; bash commits preceding writes.
programs:[{code|file,data?},...] sequential fresh guests, separate commits; stop on failure keeps earlier commits. Separate calls when the next step needs a model decision.`;
