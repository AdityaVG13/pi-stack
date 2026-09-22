# Layering over pi-multi-account

pi-rotator does not replace pi-multi-account — it routes on top of it.
Transports (OAuth logins, subscription session protocols, model catalogs)
are the worst code to duplicate, and routing is transport-agnostic: a
`setModel` to `cursor-account-2` works the same no matter who registered
the alias. So the transport owns registration and pi-rotator owns routing
decisions. This is what lets Cursor rotate with no vendored transport.

## Setup (two steps, no uninstall, no re-login)

```bash
# 1. Switch the transport's routing off (verified: every automatic switch
#    funnels through one guard on this flag; registration, discovery,
#    catalogs, usage, /login, and models.json publishing keep running).
node -e "
const fs = require('fs');
const p = process.env.HOME + '/.pi/agent/provider-failover.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.enabled = false;
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('transport routing off');
"

# 2. Install pi-rotator from your checkout (until published).
pi install ./packages/pi-rotator
```

Restart Pi, then:

```text
/rotator status     # expect: mode transport, codex + cursor active
/rotator next       # expect: switches within the current family
```

If routing is still on, pi-rotator enters standby and says so — dueling
switches are worse than none, and the fix is the one line above. (`/multi-account
disable` also works but only lasts the session; the file persists.)

Keep the transport's `onlyActive` model filter OFF while layered: hidden
slots reject switches. pi-rotator warns in status when it is on.

## What each side does

| Concern | Owner |
|---|---|
| Alias registration (all 6 transport families) | multi-account |
| Clone registration (other builtin families: xai, …) | pi-rotator |
| Routing, warmth, drain, cooldowns | pi-rotator |
| Logins, catalogs, usage, models.json | multi-account |
| Cursor transport | multi-account (vendored) |

Startup restores in the transport are one-shot intended-model planting,
not per-turn switches — they never fight per-turn routing. Manual
`/multi-account` commands keep working as explicit user overrides.

## Standalone mode

Without pi-multi-account installed, pi-rotator registers every cloneable
family itself (pi-ai builtins only) and routes them. Extension-transport
families (Cursor, Devin) report unsupported in this mode — they need the
transport layer. Nothing else changes.

## Rollback

```bash
pi remove ./packages/pi-rotator
# Re-enable transport routing:
node -e "
const fs = require('fs');
const p = process.env.HOME + '/.pi/agent/provider-failover.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.enabled = true;
fs.writeFileSync(p, JSON.stringify(c, null, 2));
"
# Restart Pi.
```

Local state (config, debug log, journal) lives under `~/.pi/agent` and is
safe to delete after rollback.
