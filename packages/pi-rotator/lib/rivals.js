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

function repositoryPath(source) {
  const repository = source.replace(/^git:(?!\/\/)/, "");

  try {
    const path = repository.includes("://") ? new URL(repository).pathname : repository.slice(repository.indexOf("/") + 1);

    // Refs can contain slashes; strip them before selecting the repository basename.
    return path.split(/[@#]/, 1)[0].replace(/\.git[/\\]*$/, "");
  } catch {
    return "";
  }
}

export function packageNameOf(source) {
  // Total: hand-edited settings can hold anything, and this runs on the
  // activate path where a throw would kill the extension silently.
  const value = source?.source || source;

  if (!value || value.constructor !== String) return "";

  if (value.startsWith("npm:")) {
    const name = value.slice(4);
    const version = name.indexOf("@", 1);

    return version === -1 ? name : name.slice(0, version);
  }

  const path = /^(git:|https?:\/\/|ssh:\/\/)/i.test(value) ? repositoryPath(value) : value;
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);

  return parts[parts.length - 1] || "";
}

function extensionSources(sources) {
  const list = Array.isArray(sources) ? sources : [];

  // An explicit empty extension filter loads no router or transport from this package.
  return list.filter(source => !Array.isArray(source?.extensions) || source.extensions.length > 0);
}

export function findRivals(sources) {
  const hits = [];
  const list = extensionSources(sources);

  for (const source of list) {
    const name = packageNameOf(source);

    if (KNOWN_RIVALS.includes(name) && !hits.includes(name)) hits.push(name);
  }

  return hits;
}

export function findTransport(sources) {
  const list = extensionSources(sources);

  for (const source of list) {
    if (TRANSPORT_PACKAGES.includes(packageNameOf(source))) return true;
  }

  return false;
}
