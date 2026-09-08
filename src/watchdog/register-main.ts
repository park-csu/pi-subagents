import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveEffectiveThinking, splitKnownThinkingSuffix } from "../shared/model-info.ts";
import { captureWatchdogDiffBaseline, type WatchdogDiffBaseline } from "./diff-tool.ts";
import { recommendStrongWatchdogModel } from "./model-selection.ts";
import { renderWatchdogWarning } from "./render.ts";
import { createMainWatchdogReview } from "./review.ts";
import { MainWatchdogRuntime, type WatchdogReviewFunction } from "./runtime.ts";
import {
	SUBAGENT_WATCHDOG_WARNING_TYPE,
	type WatchdogRuntimeStatus,
	type WatchdogWarningDetails,
} from "./types.ts";
import { createWatchdogWarningMessage } from "./warning-format.ts";

interface RegisterMainWatchdogOptions {
	runtime?: MainWatchdogRuntime;
	review?: WatchdogReviewFunction;
}

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function boolLabel(value: boolean): string {
	return value ? "on" : "off";
}

function statusLabel(status: WatchdogRuntimeStatus): string {
	return status.replaceAll("-", " ");
}

function sourceLine(source: { scope: string; path?: string; exists: boolean }): string {
	const location = source.path ? ` ${source.path}` : "";
	return `- ${source.scope}${location}: ${source.exists ? "found" : "not found"}`;
}

function currentSessionModelLine(ctx: ExtensionContext): string {
	const model = ctx.model as { provider?: unknown; id?: unknown } | undefined;
	if (model && typeof model.provider === "string" && typeof model.id === "string") return `current session (${model.provider}/${model.id})`;
	return "current session (not configured)";
}

function mainThinkingLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	const configuredModel = snapshot.config.main.model;
	const configuredThinking = snapshot.config.main.thinking;
	if (configuredModel) {
		const effective = resolveEffectiveThinking(configuredModel, configuredThinking);
		if (effective) return effective;
		return "off (default for explicit watchdog model)";
	}
	if (configuredThinking === false) return "off";
	if (configuredThinking !== undefined) return configuredThinking;
	const currentThinking = (ctx as { thinkingLevel?: unknown }).thinkingLevel;
	return typeof currentThinking === "string" ? `current session (${currentThinking})` : "current session";
}

function mainModelLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	if (snapshot.config.main.model) {
		const source = snapshot.sessionModelOverride?.model ? "session override" : "configured";
		return `Main model: ${splitKnownThinkingSuffix(snapshot.config.main.model).baseModel} (${source})`;
	}
	return `Main model: ${currentSessionModelLine(ctx)}`;
}

function childrenLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>): string {
	const children = snapshot.config.children;
	const model = children.model ? splitKnownThinkingSuffix(children.model).baseModel : "current child session";
	const thinking = children.thinking === undefined ? "current child session" : children.thinking === false ? "off" : children.thinking;
	const overrides = Object.entries(children.overrides);
	const overrideText = overrides.length
		? ` · overrides ${overrides.map(([agent, override]) => {
			const bits = [agent];
			if (override.enabled !== undefined) bits.push(boolLabel(override.enabled));
			if (override.model) bits.push(splitKnownThinkingSuffix(override.model).baseModel);
			if (override.thinking !== undefined) bits.push(`thinking ${override.thinking === false ? "off" : override.thinking}`);
			return bits.join(" ");
		}).join("; ")}`
		: "";
	return `Children: ${boolLabel(snapshot.config.enabled && children.enabled)} · model ${model} · thinking ${thinking}${overrideText}`;
}

function recommendationLine(ctx: ExtensionContext): string {
	try {
		const recommendation = recommendStrongWatchdogModel(ctx);
		return `Recommended strong watchdog: ${recommendation.model}:${recommendation.thinking} (${recommendation.label}, complementary reviewer)`;
	} catch (error) {
		return `Recommended strong watchdog: unavailable (${messageFromError(error)})`;
	}
}

function lspLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>): string {
	const lsp = snapshot.lsp;
	const provider = lsp.provider ? ` · ${lsp.provider}` : "";
	const counts = lsp.diagnosticCount > 0 || lsp.freshDiagnosticCount > 0
		? ` · ${lsp.freshDiagnosticCount} new/${lsp.diagnosticCount} total`
		: "";
	const message = lsp.message ? ` · ${lsp.message}` : "";
	return `LSP diagnostics: ${lsp.enabled ? "on" : "off"} · ${lsp.status}${provider}${counts}${message}`;
}

export function buildWatchdogStatus(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	const lines = [
		"Subagent watchdog",
		`Main: ${boolLabel(snapshot.enabled)}${!snapshot.config.enabled && snapshot.sessionOverride === undefined ? " (default off)" : ""}`,
		`Runtime: ${statusLabel(snapshot.status)}${snapshot.bufferedDeltas > 0 ? ` · buffered deltas ${snapshot.bufferedDeltas}` : ""}`,
		`Review trigger: ${snapshot.reviewTrigger === "repo-edits" ? snapshot.config.clarification ? "repo edits + bounded main orchestration activity" : "repo edits only" : "every non-empty turn delta"}`,
		`Main clarification: ${snapshot.config.clarification ? "on" : "off"}`,
		`Scope context: ${snapshot.config.scope.enabled ? "on" : "off"}`,
		`Cadence: ${snapshot.config.cadence.everyNTools === null ? "boundary only" : `every ${snapshot.config.cadence.everyNTools} tools + boundary`}`,
		lspLine(snapshot),
		`Session override: ${snapshot.sessionOverride === undefined ? "none" : boolLabel(snapshot.sessionOverride)}`,
		mainModelLine(snapshot, ctx),
		`Main thinking: ${mainThinkingLine(snapshot, ctx)}`,
		childrenLine(snapshot),
		recommendationLine(ctx),
		`Agent-end timeout: ${snapshot.config.agentEndTimeoutMs}ms`,
		`Stalemate: ${snapshot.boundaryRepeats}/${snapshot.config.stalemateRepeats}${snapshot.stalemate ? " · stopped" : ""}`,
		`Rules: ${snapshot.config.rules ? `${Object.keys(snapshot.config.rules.roleModels).length} role models · ${snapshot.config.rules.action}` : "none"}`,
		`Review model call: ${snapshot.reviewDescription}`,
	];
	if (snapshot.failedReviews > 0) lines.push(`Failed reviews: ${snapshot.failedReviews}`);
	if (snapshot.staleReviews > 0) lines.push(`Stale reviews: ${snapshot.staleReviews}`);
	if (snapshot.changedPaths?.length) {
		lines.push(`Changed paths: ${snapshot.changedPaths.slice(0, 8).join(", ")}${snapshot.changedPaths.length > 8 ? `, +${snapshot.changedPaths.length - 8} more` : ""}`);
	}
	if (snapshot.lastWarning) {
		lines.push(`Last warning: ${snapshot.lastWarning.severity} · ${snapshot.lastWarning.state ?? "candidate"} · ${snapshot.lastWarning.summary}`);
	}
	if (snapshot.lastError) lines.push(`Last error: ${snapshot.lastError}`);
	if (!snapshot.configOk) {
		lines.push("", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`), "Watchdog is disabled until the config is fixed.");
	} else {
		lines.push("", "Config: ok");
	}
	lines.push("Sources:", ...snapshot.sources.map(sourceLine));
	return lines.join("\n");
}

export function registerMainWatchdog(pi: ExtensionAPI, options: RegisterMainWatchdogOptions = {}): MainWatchdogRuntime {
	let currentContext: ExtensionContext | undefined;
	let diffBaseline: WatchdogDiffBaseline | undefined;
	const rememberContext = (ctx: ExtensionContext) => {
		currentContext = ctx;
	};
	const runtime = options.runtime ?? new MainWatchdogRuntime({
		review: options.review ?? createMainWatchdogReview(() => currentContext, { getThinkingLevel: () => pi.getThinkingLevel(), diffBaseline: () => diffBaseline }),
		reviewDescription: options.review ? "injected seam" : "real model review",
		reviewChangesOnly: true,
		displayWarning: (details, options) => pi.sendMessage(createWatchdogWarningMessage(details, { display: true, details }), options),
		displayClarification: (content) => pi.sendMessage({ customType: "subagent_watchdog_clarification", content, display: true }, { deliverAs: "steer", triggerTurn: true }),
	});

	pi.registerMessageRenderer<WatchdogWarningDetails>(SUBAGENT_WATCHDOG_WARNING_TYPE, (message, renderOptions, theme) => {
		const details = message.details as WatchdogWarningDetails | undefined;
		if (!details?.summary || !details.evidence || !details.recommendedAction) {
			const content = typeof message.content === "string"
				? message.content
				: message.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
			return new Text(content, 0, 0);
		}
		return renderWatchdogWarning(details, renderOptions, theme);
	});

	pi.on("session_start", (_event, ctx) => {
		rememberContext(ctx);
		diffBaseline = captureWatchdogDiffBaseline(ctx.cwd);
		runtime.bindSession(ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		rememberContext(ctx);
		runtime.handleBeforeAgentStart(event, ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		rememberContext(ctx);
		runtime.handleTurnEnd(event, ctx);
	});
	pi.on("input", (event) => { if (event.source !== "extension") runtime.handleUserInput(); });
	pi.on("model_select", () => runtime.handleModelChange());
	pi.on("tool_result", (_event, ctx) => {
		rememberContext(ctx);
		runtime.handleToolResult(ctx);
	});
	pi.on("agent_end", (event, ctx) => {
		rememberContext(ctx);
		return runtime.handleAgentEnd(event, ctx);
	});
	pi.on("session_before_switch", () => runtime.reset("session switch", { clearReviewInputSignature: true, clearLspLedger: true, clearScope: true }));
	pi.on("session_before_fork", () => runtime.reset("session fork", { clearReviewInputSignature: true, clearLspLedger: true, clearScope: true }));
	pi.on("session_compact", () => runtime.reset("session compact", { clearScope: true }));
	pi.on("session_shutdown", () => {
		currentContext = undefined;
		runtime.dispose();
	});

	return runtime;
}
