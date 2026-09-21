import {createRequire} from 'node:module';

// Sync only, never top-level await. Dynamic import of host/deps hung OMP plugin load.
const require = createRequire(import.meta.url);

let Type;

try {
  Type = require("typebox").Type;
} catch {
  Type = {
    Object: (props, opts) => ({ type: "object", properties: props || {}, additionalProperties: false, ...opts }),
    String: (opts) => ({ type: "string", ...opts }),
    Unknown: (opts) => ({ ...opts }),
    Array: (items, opts) => ({ type: "array", items, ...opts }),
    Integer: (opts) => ({ type: "integer", ...opts }),
    Optional: (s) => ({ ...s }),
    Boolean: (opts) => ({ type: "boolean", ...opts }),
  };
}

export function programParameters(config) {
  return Type.Object({
      code: Type.Optional(Type.String({ maxLength: config.maxCodeChars ?? 48000 })),
      file: Type.Optional(Type.String({ minLength: 1 })),
      data: Type.Optional(Type.Unknown()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
      programs: Type.Optional(Type.Array(Type.Object({
        code: Type.Optional(Type.String({ maxLength: config.maxCodeChars ?? 48000 })),
        file: Type.Optional(Type.String({ minLength: 1 })),
        data: Type.Optional(Type.Unknown()),
      }, {additionalProperties:false}), {minItems:1,maxItems:32})),
      parallel: Type.Optional(Type.Boolean()),
      mergeData: Type.Optional(Type.Boolean()),
    });
}
