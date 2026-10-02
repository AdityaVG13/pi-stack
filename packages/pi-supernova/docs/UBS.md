# UBS review boundaries (0.11.0)

UBS is advisory, not a clean security gate. Reviewed with meta-runner 5.3.7
and JavaScript module 4.7. Do not suppress entire categories or rewrite correct
behavior merely to make the scan green. Package tests and oxlint remain gates.

## Documented exceptions

| Finding | Evidence and boundary |
| --- | --- |
| Loose equality | `workspace.js`, `output/bottleneck.js`, and `ui/render.js` use `== null` / `!= null` solely to cover both null and undefined. No arbitrary coercing equality is intended. |
| Global assignments | Examples in `fs/lines.js`, `fs/read-window.js`, `shared/png.js`, and `bridge/tool-registry.js` assign variables already declared in lexical scope. ESM plus oxlint's undeclared-variable check is the gate; the scanner's text heuristic loses declaration context. |
| Token/secret comparisons | Samples include `supportsNativeArgv() === true`, timeout defaults and overlay-depth checks. These are booleans, ownership identities, AST tokens or filesystem digests, not authentication secrets. SHA-256 file signatures are CAS fingerprints, not credentials. No constant-time authentication claim is made. |
| Hardcoded secret | `fs/commit.js` constructs `.supernova-` plus `randomUUID()` for a temporary filename. This is neither a secret nor a literal credential. |
| Prototype pollution / sensitive logging / JWT bypass | Test programs deliberately exercise forbidden properties and reference symbols named `token` or `secret`. They are negative-test/source fixtures, not prototype writes, credentials, production logging, or a JWT verifier. |
| Ignored async map | The sample in `tests/efficiency/tokens.mjs` is a guest-program string with `return await Promise.all(...map(async ...))`; results are awaited in the guest. |
| Async event listeners | `index.js` registers Pi extension events, whose host contract awaits handlers. These are not Node EventEmitter listeners. Replacing them with fire-and-forget handlers would break lifecycle ordering. |
| Arithmetic / array bounds / sparse arrays / mutation | Examples include division by literal 2 or 1048576, positive/clamped batch shares, guarded line indices, lookahead intentionally returning undefined, and arrays filled immediately after allocation. Container operations on another collection are not mutation of the iterated collection. These are site-specific invariants, not permission to ignore new findings. |
| JSON parsing / deep access | Parse failures propagate through the owning tool/program error boundary; adding local catches everywhere would hide failures. Validated AST nodes, initialized state and native process handles explain sampled deep-access warnings. Untrusted inputs still require their existing validation. |
| Archive traversal / dynamic regex | Workspace destination paths go through lexical and canonical containment checks. Search literals are escaped before regex construction; structural parsers intentionally accept regex syntax. These findings do not establish an archive extractor or an outbound upload surface. |
| Interval leaks / synchronous calls | Child/guest fixture programs intentionally live until cancellation or process retirement. Production watchdogs and polling timers have owning cleanup paths. Synchronous calls used in CLI/test processes or host initialization are not an async hot-path promise. |
| Style / DOM warnings | Function parameter counts, ternaries, nested functions and no-op callbacks are stylistic. `prompt`/`confirm` references are host TUI operations, not browser blocking dialogs. |

Exceptions apply to the reviewed patterns, not blanket exclusions. Raw scans
may remain nonzero. Counts can include duplicate checks and test-string matches;
never report them as a clean pass or a count of distinct defects.

## Platform verification constraints

Windows needs a working native `rg.exe` and Git for Windows Bash on PATH,
not a broken application link or WSL launcher. The verification PATH also
includes Git's `usr/bin` for literal-argv fixtures such as `printf`; pin
`System32/tar.exe` for drive-letter archive paths rather than Git's GNU tar. Backup/restore privileges on an
administrative SSH token bypass read ACLs. Permission-denial tests therefore
run in an isolated verification process with those two privileges disabled;
production code and host-wide security settings are unchanged.

Windows sharing violations retry replacement at most three times, waiting 10 ms
between attempts. Publication rechecks version, content, cancellation and session
ownership; recovery rechecks published content so retries never overwrite a new
external edit. Persistent errors remain failures with retained recovery backups.

Windows content checks deliberately add disk hashing where timestamp metadata
cannot distinguish same-size writes. Unix whole-file reads retain the existing
single-pass baseline path. No cross-platform performance equivalence is claimed.
Existing platform-specific test skips remain disclosed, not converted into passes.
