// Complete model-facing API reference; kept in every request, not moved into history.
export const REFERENCE = `Run one JavaScript program with four familiar commands: read, write, edit, bash. Use an async body or arrow. Return a small value; strings stay raw. For a single program, supply exactly one of code or file; file rereads a workspace program with the same limits and fresh guest, without resending its source.

Native commands (async):
read(path|paths, offset?, limit?) → file text or text[]; read(directory) → directory entries
read(imagePath) → image attachment when returned (PNG/JPEG/GIF/WebP/BMP); no browser needed
read({path,json:".field"}) → parsed JSON field; supports .items[0:3], quoted keys, selector arrays, or true for the whole JSON value
read("agent://id?q=.answer") → JSON field from a calling-session resource (when host artifacts are available)
read("symbol or question") → locate and open source in one call, without an index; selected file text stays raw
read({query, resolve:true}) → {status,path,line,lines,text,complete,nextOffset?} for a direct resolve→edit handoff
read(path, {about: question}) → relevant file bodies, or source selection inside a directory
read({query, evidence:true}) → ranked evidence; read({path, outline:true}) → structural declarations
write(path, text) → write a file; write({path,content,append:true}) appends a chunk without a bounded read
edit(path, oldText, newText) → post-edit lines, checks, and references
edit(async () => {...}) → filesystem checkpoint: commit on success, rollback on throw; no shell commands, nesting, or concurrent outside commands
bash(command, {cwd?, timeoutMs?}) → bounded output; throws on non-zero exit
bash({command, args:[...]}) → literal argv without shell expansion of arguments

Only found selects and opens a file. Uncertain reads return ambiguous, not_found, or incomplete with no selected path. Use resolve:true for structured status checks; narrow the directory with path+about when uncertain.
For read-modify-write, use read({path,complete:true}); it rejects partial output. For large JSON use json selectors: parse first, then project within the read budget (16 MiB input cap; no full jq). Do not JSON.parse line windows. For large text audits use about or offset/limit, not complete:true. Prefer edit for large files. Array reads reject failures; use Promise.allSettled for per-path outcomes.
Object arguments also work: read({path, offset?, limit?, about?, outline?, evidence?, resolve?, complete?}), edit({path, edits:[{oldText,newText}]}), edit({path,patch}), write({path,content}), bash({command,timeoutMs?}).
File changes stage until program success; later errors roll them back. Shell calls commit preceding writes and cannot be rolled back. Outcomes report committed/rolledBack file versions and external-call attempts.
Independent read starts batch automatically. Mutations preserve submission order. Plain reads remain self-contained; oversized reads provide continuation offsets. Return only what the model needs. console.log is captured.

For known continuations use programs:[{code|file,data?},...]. Entries run sequentially in fresh guests with separate commits. The batch stops on failure and returns all attempted results, including a typed stop report; earlier commits remain. Deadlines, host calls, logs and output are shared across the batch. Use separate calls when the next action needs model reasoning.`;
