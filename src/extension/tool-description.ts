import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION =
	"Run configured agents directly or compose them with workflowScript.";

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "";
export const SUBAGENT_TOOL_PROMPT_GUIDELINES: string[] = [];
export const SUBAGENT_SAFETY_GUIDANCE = "";
export const FULL_SUBAGENT_TOOL_DESCRIPTION = DEFAULT_SUBAGENT_TOOL_DESCRIPTION;
export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = DEFAULT_SUBAGENT_TOOL_DESCRIPTION;

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
}

export interface SubagentToolPromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function buildSubagentToolPromptMetadata(
	_config: Pick<ExtensionConfig, "toolDescriptionMode"> = {},
): SubagentToolPromptMetadata {
	return {};
}

export function resolveToolDescriptionMode(
	config: Pick<ExtensionConfig, "toolDescriptionMode">,
	_options?: ToolDescriptionOptions,
): ToolDescriptionMode {
	return config.toolDescriptionMode === "compact" || config.toolDescriptionMode === "custom"
		? config.toolDescriptionMode
		: "full";
}

export function buildSubagentToolDescription(
	_config: Pick<ExtensionConfig, "toolDescriptionMode"> = {},
	_options?: ToolDescriptionOptions,
): string {
	return DEFAULT_SUBAGENT_TOOL_DESCRIPTION;
}
