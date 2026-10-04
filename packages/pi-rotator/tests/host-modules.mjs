// Standalone node:test must use the same SDK as Pi, without installing runtime
// peer copies. The production extension loader supplies these bindings itself.
import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const command = (process.env.PATH || "").split(delimiter).map(dir => join(dir, "pi")).find(existsSync);

const entry = process.env.PI_ROTATOR_TEST_HOST || (command && realpathSync(command));

if (entry) {
  const parentURL = pathToFileURL(entry).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.conditions.includes("require") && (specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/"))) return nextResolve(specifier, { ...context, parentURL });

      return nextResolve(specifier, context);
    },
  });
}
