/**
 * pi-model-sync shared test fakes.
 *
 * Route-table fetch stub, JSON responses, and temp dirs. No assertions here:
 * each suite keeps its own expectations; this module only builds inputs.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNumber, isObject } from "../lib/decode.js";

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function tempDir(prefix = "modelsync-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Routes map exact URL strings to bodies. A numeric route is an HTTP error
// status, {raw} serves a literal body, anything else is served as JSON.
// Unknown URLs 404. Returns {fetchImpl, seen} with seen recording every
// request's url and headers.
export function stubFetch(routes) {
  const seen = [];

  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {} });

    const route = routes[String(url)];

    if (route === undefined) {
      return new Response("not found", { status: 404 });
    }

    if (isNumber(route)) {
      return new Response(`{"error":"http ${route}"}`, { status: route });
    }

    if (isObject(route) && route.raw !== undefined) {
      return new Response(route.raw, { status: 200 });
    }

    return jsonResponse(route);
  };

  return { fetchImpl, seen };
}
