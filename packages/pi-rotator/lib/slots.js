// Slot identity for every provider family.
//
// Convention (shared with pi-multi-account): the base provider id is slot 1,
// `{base}-account-N` (N >= 2) are slots 2..N. Any base with numbered siblings
// in auth.json is a family — no family table, so providers pi-rotator has
// never heard of join the rotation with zero code changes.
const SLOT_SUFFIX = /-account-(\d+)$/;

export function slotId(base, n) {
  if (n <= 1) return base;

  return `${base}-account-${n}`;
}

// { base, n } for any family member id, or null for malformed suffixes and
// non-strings. A bare id is slot 1 of its own family. `-account-1` is not a
// canonical id (slot 1 is the bare base) and is rejected, matching upstream
// discovery which only generates canonical ids.
export function parseSlotId(providerId) {
  // Total: never throws, only string-typed values pass. (Boxed Strings
  // pass too; they never occur as provider ids.)
  if (!providerId || providerId.constructor !== String) return null;
  const match = SLOT_SUFFIX.exec(providerId);

  if (!match) return { base: providerId, n: 1 };
  const n = Number.parseInt(match[1], 10);

  if (!Number.isSafeInteger(n) || n < 2) return null;

  return { base: providerId.slice(0, match.index), n };
}

// Families eligible for rotation: bases with at least one numbered slot.
// Lone base keys (single login, nothing to rotate) stay out to keep status
// lean. Numbered slots without a base key still form a family — cloning needs
// the pi-ai factory, not a base credential.
export function discoverFamilies(auth) {
  const groups = new Map();

  for (const id of Object.keys(auth || {})) {
    const slot = parseSlotId(id);

    if (!slot || slot.n < 2) continue;

    if (!groups.has(slot.base)) groups.set(slot.base, new Set());
    groups.get(slot.base).add(slot.n);
  }

  const families = [];

  for (const [base, numbers] of groups) {
    const slots = [];

    if (Object.hasOwn(auth, base)) slots.push(base);

    for (const n of [...numbers].sort((a, b) => a - b)) {
      slots.push(slotId(base, n));
    }

    families.push({ base, slots });
  }

  families.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));

  return families;
}

export function nextFreeSlot(auth, base) {
  let n = 1;

  while (Object.hasOwn(auth || {}, slotId(base, n))) n += 1;

  return slotId(base, n);
}
