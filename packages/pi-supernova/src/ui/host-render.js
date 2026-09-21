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
 *   OMP: (result, {expanded,isPartial}, theme, args)  (4th is args, not context)
 *
 * Call shapes share the first three positions, so host is inferred from the
 * fourth argument's context-versus-args shape.
 */
function contextFrom(opts, ctxOrArgs) {
	if (isObject(ctxOrArgs) && !isTheme(ctxOrArgs)) {
		if ("lastComponent" in ctxOrArgs || "state" in ctxOrArgs || "invalidate" in ctxOrArgs) return ctxOrArgs;
	}

	return { state: opts.state, lastComponent: opts.lastComponent };
}

function isRenderContext(value) {
	return "lastComponent" in value || "invalidate" in value;
}

function isToolArgs(value) {
	return "code" in value || "file" in value || "programs" in value || "timeoutMs" in value;
}

function detectResultHost(options, ctxOrArgs) {
  if (isTheme(options) || !isObject(ctxOrArgs) || isRenderContext(ctxOrArgs)) return "pi";
  return isToolArgs(ctxOrArgs) ? "omp" : "pi";
}

function ensureState(context) {
	if (!isObject(context.state)) context.state = {};

	return context;
}

function resultArgs(ctxOrArgs, context) {
	return ctxOrArgs?.code || ctxOrArgs?.file || ctxOrArgs?.programs ? ctxOrArgs : context.args;
}

function piResultArgs(result, options, theme, ctxOrArgs) {
  const opts = isObject(options) ? options : {};
  const context = ensureState(contextFrom(opts, ctxOrArgs));
  return resultRenderModel(result, theme, context, opts, opts, detectResultHost(options, ctxOrArgs), resultArgs(ctxOrArgs, context));
}

function resultRenderModel(result, theme, context, flags, options, host, args) {
  return { result, theme, context, options, host, args, expanded: !!flags.expanded, isPartial: !!flags.isPartial };
}

function oddballResultArgs(result, theme, themeOrCtx) {
  const context = ensureState(isObject(themeOrCtx) ? themeOrCtx : {});
  return resultRenderModel(result, theme, context, context, {}, "pi", context.args);
}

function normalizeResultRenderArgs(result, options, themeOrCtx, ctxOrArgs) {
	if (isTheme(themeOrCtx)) return piResultArgs(result, options, themeOrCtx, ctxOrArgs);

	if (isTheme(options)) return oddballResultArgs(result, options, themeOrCtx);

	throw new Error("supernova renderResult: theme missing (expected Pi or OMP signature)");
}
export {normalizeResultRenderArgs};
