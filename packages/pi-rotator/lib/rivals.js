// Rival balancer detection. Two active routers would fight over setModel with
// split cooldown state, so pi-rotator refuses that fight and enters standby
// instead (see index.js).
//
// pi-multi-account is NOT a rival: it is the transport layer (see
// lib/transport.js). With its routing switched off it owns alias
// registration while pi-rotator owns routing decisions.
const KNOWN_RIVALS = [
  "@henryqw/pi-multi-codex",
  "pi-account-pool",
  "pi-failover",
  "@hu3rror/pi-failover",
  "pi-ccswitch-auto-switch",
  "codex-cliproxy-gateway",
];

const TRANSPORT_PACKAGES = ["pi-multi-account", "@jischeng/pi-multi-account"];

export function packageNameOf(source) {
  // Total: hand-edited settings can hold anything, and this runs on the
  // activate path where a throw would kill the extension silently.
  if (!source || source.constructor !== String) return "";

  if (source.startsWith("npm:")) return source.slice(4);
  const parts = source.split("/");

  return parts[parts.length - 1] || "";
}

export function findRivals(sources) {
  const hits = [];
  const list = sources || [];

  for (const source of list) {
    const name = packageNameOf(source);

    if (KNOWN_RIVALS.includes(name) && !hits.includes(name)) hits.push(name);
  }

  return hits;
}

export function findTransport(sources) {
  const list = sources || [];

  for (const source of list) {
    if (TRANSPORT_PACKAGES.includes(packageNameOf(source))) return true;
  }

  return false;
}
