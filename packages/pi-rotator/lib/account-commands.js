// Login provisioning, completion and guarded account management. Never remove
// active credentials or take ownership from a foreign account provider.
import { parseSlotId, slotId } from "./slots.js";
import { providerBase, registerOwnedAlias, nativeFamilyNames, rediscover } from "./accounts.js";
import { readJson } from "./support.js";
import { showText } from "./command-ui.js";
import { effectiveAuth } from "./credentials.js";
import { removeAccount } from "./management.js";

function canPrefill(ctx) {
  return ctx?.mode === "tui" && ctx?.hasUI !== false;
}

function prefillLogin(ctx, id) {
  // RPC cannot read the client's draft: getEditorText() always returns empty.
  // Prefill is TUI-only and never submits the command or replaces a draft.
  if (!canPrefill(ctx)) return;

  try {
    if (ctx.ui?.getEditorText?.() === "") ctx.ui.setEditorText?.("/login " + id);
  } catch {
    // Cosmetic failure must not misreport an already registered account.
  }
}

function validAccountAdd(tokens) {
  const [action, base] = tokens;
  const parsed = parseSlotId(base);

  return tokens.length === 2 && action === "add" && parsed && parsed.n === 1 && !base.endsWith("-account-1");
}

function packageOwns(base, ctx) {
  return ctx?.modelRegistry?.getRegisteredProviderConfig?.(base) && !ctx.modelRegistry.getRegisteredNativeProvider?.(base);
}

function accountProvider(base, ctx, state) {
  const provider = providerBase(base, ctx?.modelRegistry, undefined, state);

  return { provider, owned: !provider && packageOwns(base, ctx) };
}

function nextAvailableAccount(auth, state, base, ctx) {
  let n = 2; // Slot 1 remains owned by the base provider.
  let id = slotId(base, n);

  while (Object.hasOwn(auth, id) || state.preparedAccounts.has(id) || state.ownedAliases.has(id) || ctx?.modelRegistry?.getProvider?.(id)) {
    id = slotId(base, ++n);
  }

  return { id, n };
}

async function prepareCursorAccount(dir, state, ctx) {
  const auth = readJson(dir, "auth.json");
  const { id } = nextAvailableAccount(auth, state, "cursor", ctx);
  // Setup yields while binding/importing; overlapping commands need a reservation.
  state.preparedAccounts.add(id);
  let ready = false;

  try {
    ready = await state.cursor.prepare([id], ctx?.modelRegistry);

    if (!ready) return showText(ctx, "pi-rotator: the provider package owns cursor; use its account registration flow.");
  } catch {
    return showText(ctx, "pi-rotator: Cursor registration rejected; account not created.");
  } finally {
    if (!ready) state.preparedAccounts.delete(id);
  }

  prefillLogin(ctx, id);

  return showText(ctx, "pi-rotator: prepared " + id + ". Run /login " + id + "; the next Rotator command or task will pick up the account. No credentials or current model changed.");
}

export function accountCommand(pi, dir, state, tokens, ctx) {
  const [, base] = tokens;

  if (!validAccountAdd(tokens)) {
    return showText(ctx, "Usage: /rotator account add <native-provider-family>");
  }

  if (state.mode === "transport") {
    return showText(ctx, "The legacy transport owns account registration. Native preparation requires removing that configured transport and restarting; no settings were changed.");
  }

  if (base === "cursor" && state.cursor) return prepareCursorAccount(dir, state, ctx);
  const { provider, owned } = accountProvider(base, ctx, state);

  if (owned) {
    return showText(ctx, "pi-rotator: the provider package owns " + base + "; use its account registration flow. Existing accounts can still rotate.");
  }

  if (!provider) return showText(ctx, "pi-rotator: no native provider for " + base + "; account not created.");
  const auth = readJson(dir, "auth.json");
  const { id, n } = nextAvailableAccount(auth, state, base, ctx);

  try {
    // Prepared slots have no credentials yet, so they never carry the
    // family listing; discovery promotes a carrier once one logs in.
    registerOwnedAlias(pi, state, base, provider, id, n, true);
    state.preparedAccounts.add(id);
  } catch {
    return showText(ctx, "pi-rotator: native registration rejected; account not created.");
  }

  prefillLogin(ctx, id);

  return showText(ctx, "pi-rotator: prepared " + id + ". Run /login " + id + "; the next Rotator command or task will pick up the account. /rotator refresh also works. No credentials or current model changed.");
}

export function canChoose(ctx) {
  return ctx?.hasUI !== false && ctx?.ui?.select != null;
}

export function commandCompletions(prefix, names) {
  const input = prefix.trimStart();
  let values = ["add", "next", "fast", "status", "refresh", "hide", "menu", "rediscover", "account add", "accounts", "limits", "remove", "reset", "cutover"];

  if (input.startsWith("fast ")) values = ["fast on", "fast off", "fast status"];
  else if (input.startsWith("add ")) values = names.map(name => "add " + name);
  else if (input.startsWith("account add ")) values = names.map(name => "account add " + name);

  const matches = values.filter(value => value.startsWith(input));

  return matches.length ? matches.map(value => ({ value, label: value })) : null;
}

function defaultAccountBase(tokens, ctx) {
  return tokens[0] || parseSlotId(ctx?.model?.provider)?.base;
}

export async function addShortcut(pi, dir, state, tokens, ctx) {
  if (tokens.length > 1) return showText(ctx, "Usage: /rotator add [provider]");
  // Serving family is exact: Codex is never silently migrated to OpenAI.
  let base = defaultAccountBase(tokens, ctx);

  if (!base && state.mode !== "transport" && canChoose(ctx)) {
    base = await ctx.ui.select("Add account -- provider", nativeFamilyNames(ctx?.modelRegistry, state.cursor, state));

    if (!base) return;
  }

  if (!base) return showText(ctx, "Choose a model first, or use /rotator add <provider>.");

  return accountCommand(pi, dir, state, ["add", base], ctx);
}

export async function confirmAction(tokens, ctx, title, message) {
  if (tokens.includes("confirm")) return true;

  if (ctx?.hasUI === false || !ctx?.ui?.confirm) return false;

  return ctx.ui.confirm(title, message);
}

export async function accountsCommand(_pi, dir, state, _config, tokens, ctx) {
  return showText(ctx, await state.usage.describe(Object.keys(effectiveAuth(dir)), tokens.includes("refresh"), ctx));
}

export async function limitsCommand(_pi, _dir, state, _config, tokens, ctx) {
  return showText(ctx, ctx?.model ? await state.usage.describe([ctx.model.provider], tokens.includes("refresh"), ctx) : "No active provider selected.");
}

function forgetRemovedAlias(pi, dir, state, id) {
  // A still-present login keeps its reservation. Base providers are never
  // Rotator aliases; numbered slots stay reserved until unregister so
  // /rotator add cannot reuse a ghost host entry.
  if (Object.hasOwn(effectiveAuth(dir), id) || (parseSlotId(id)?.n ?? 1) < 2) return;

  state.preparedAccounts.delete(id);

  if (!state.ownedAliases.has(id)) return;

  try { pi?.unregisterProvider?.(id); } catch { /* login is already gone */ }

  state.ownedAliases.delete(id);
  state.nativeAliases?.delete(id);
  state.cursor?.forgetSlot?.(id);
}

export async function removeCommand(pi, dir, state, _config, tokens, ctx) {
  const requested = tokens[1];
  const family = state.families.get(requested);
  const id = family ? family.slots.at(-1) : requested;

  if (!id || !Object.hasOwn(effectiveAuth(dir), id)) return showText(ctx, "Usage: /rotator remove <provider-id or family>");

  if (state.mode === "transport") return showText(ctx, "Cut over first, or use the legacy owner's /logout flow. No login changed.");
  const confirmed = await confirmAction(tokens.slice(2), ctx, "Remove account", "Log out " + id + "? Other accounts and defaults are unchanged.");

  if (!confirmed) return showText(ctx, "No login changed. To confirm explicitly: /rotator remove " + id + " confirm");

  try {
    await removeAccount(dir, id, ctx);
    forgetRemovedAlias(pi, dir, state, id);
    rediscover(pi, dir, state, undefined, ctx?.modelRegistry);

    return showText(ctx, "Removed login " + id + ". The slot remains available for a new /login.");
  } catch {
    forgetRemovedAlias(pi, dir, state, id);

    return showText(ctx, "Account removal did not finish cleanly; the login may already be removed. Refresh account status or restart Pi before retrying. Active accounts must be switched away from first.");
  }
}
