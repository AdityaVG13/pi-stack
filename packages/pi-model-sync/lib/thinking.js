/**
 * pi-model-sync thinking maps.
 *
 * Pi selects a thinking level (off/minimal/low/medium/high/xhigh/max) and each
 * API adapter translates the mapped value to the wire. Unknown models get the
 * conservative ladder (standard names, no xhigh/max); explicit wire values
 * from live metadata or models.dev always win via nearest-match, ties to the
 * lower rung. Map values of null hide that Pi level (getSupportedThinkingLevels
 * skips them), so off is omitted unless the source advertises none/off.
 */

import { defined, isString } from "./decode.js";

// Ordered reasoning ladder. Index distance drives nearest-match.
export const LADDER = ["minimal", "low", "medium", "high", "xhigh"];

function ladderIndex(value) {
  return LADDER.indexOf(value);
}

function nearestLadderValue(want, have) {
  const wantIndex = ladderIndex(want);
  let best = null;
  let bestDistance = Infinity;

  for (const candidate of have) {
    const candidateIndex = ladderIndex(candidate);

    if (candidateIndex < 0) {
      continue;
    }

    const distance = Math.abs(candidateIndex - wantIndex);

    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

// Map one Pi level onto explicit wire values. Falls back to the Pi level
// name itself when the values carry no ladder member (custom dialects the
// engine cannot interpret keep Pi default behavior).
function mapLevel(level, values) {
  if (values === null) {
    return level;
  }

  const ladderValues = [...new Set(values.filter((value) => isString(value) && ladderIndex(value) >= 0))];

  if (ladderValues.length === 0) {
    return level;
  }

  // Sort by ladder index so ties-to-lower is deterministic regardless of
  // advertisement order; the nearest loop keeps the first on ties.
  ladderValues.sort((a, b) => ladderIndex(a) - ladderIndex(b));

  return nearestLadderValue(level, ladderValues) ?? level;
}

// xhigh/max are only advertised when explicitly offered (unknown models
// get neither). Anything else leaves them unsupported so Pi clamps down
// instead of sending a value the server may reject with 400.
function gatedLevel(level, values) {
  if (values === null) {
    return null;
  }

  return values.includes(level) ? level : null;
}

// Pi treats thinkingLevelMap.off === null as "off is unsupported". Prefer an
// advertised none/off wire value; otherwise omit the key so /thinking off stays.
function offLevel(values) {
  if (values === null) {
    return undefined;
  }

  if (values.includes("none")) {
    return "none";
  }

  if (values.includes("off")) {
    return "off";
  }

  return undefined;
}

// Build the thinking config for one model. explicitValues is the wire
// effort list from live metadata or models.dev, or null when unknown.
export function buildThinking(reasoning, explicitValues) {
  if (reasoning !== true) {
    return { reasoning: false };
  }

  const values = explicitValues === undefined ? null : explicitValues;

  return {
    reasoning: true,
    thinkingLevelMap: defined({
      off: offLevel(values),
      minimal: mapLevel("minimal", values),
      low: mapLevel("low", values),
      medium: mapLevel("medium", values),
      high: mapLevel("high", values),
      xhigh: gatedLevel("xhigh", values),
      max: gatedLevel("max", values),
    }),
  };
}
