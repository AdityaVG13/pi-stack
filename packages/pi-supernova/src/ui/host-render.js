import {isObject,isFunction} from '../shared/decode.js';

function isTheme(value) {
	return isObject(value) && isFunction(value.fg);
}

/**
 * Dual-host renderCall args:
 *   Pi:  (args, theme, context)
 *   OMP: (args, options/renderState, theme)
 */
export function normalizeCallRenderArgs(a, b, c) {
	if (isTheme(b)) {
		const context = isObject(c) ? c : {};

		if (!isObject(context.state)) context.state = {};

		return { args: a, theme: b, context, host: "pi" };
	}

	if (isTheme(c)) {
		const options = isObject(b) ? b : {};

		if (!isObject(options.state)) options.state = {};

		const context = {
			...options,
			state: options.state,
			expanded: options.expanded,
			isPartial: options.isPartial,
			executionStarted: options.executionStarted,
			argsComplete: options.argsComplete,
			lastComponent: options.lastComponent,
			invalidate: options.invalidate,
		};

		return { args: a, theme: c, context, host: "omp", options };
	}

	throw new Error("supernova renderCall: theme missing (expected Pi or OMP signature)");
}

/**
 * Dual-host renderResult args:
 *   Pi:  (result, {expanded,isPartial}, theme, context)
 *   OMP: (result, {expanded,isPartial,lastComponent,invalidate,state}, theme, args)
 *
 * Both hosts put their options at position 2 and the theme at position 3, but the
 * 4th argument differs: Pi sends a render context, OMP sends the tool args. A
 * render context at position 4 is unambiguous, so it decides first; otherwise
 * OMP's live render state in the options object does. Sniffing the 4th argument
 * alone misread OMP calls whose args omit code/file/programs/timeoutMs as Pi and
 * painted a second background over the host's.
 */
function isRenderContext(value) {
	return isObject(value) && ("lastComponent" in value || "invalidate" in value || "state" in value);
}

function ensureState(context) {
	if (!isObject(context.state)) context.state = {};

	return context;
}

function normalizeResultRenderArgs(result, options, theme, ctxOrArgs) {
	if (!isTheme(theme)) throw new Error("supernova renderResult: theme missing (expected Pi or OMP signature)");

	const opts = isObject(options) ? options : {};
	const piContext = isRenderContext(ctxOrArgs);
	const host = !piContext && isRenderContext(opts) ? "omp" : "pi";
	const context = ensureState(piContext ? ctxOrArgs : { state: opts.state, lastComponent: opts.lastComponent });

	return { result, theme, context, options: opts, host, expanded: !!opts.expanded, isPartial: !!opts.isPartial };
}

export {normalizeResultRenderArgs};
