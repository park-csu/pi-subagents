import { uiTone } from "ui-kit/appearance";
import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, getMarkdownTheme,
  createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { statusLine } from "./activity.ts";
import { styleToolDefinition } from "ui-kit/tools";

// Preserve Markdown/code whitespace, removing terminal control sequences from recorded data.
export function cleanTranscriptText(text) {
  return String(text ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
function clean(value) {
  if (typeof value === "string") return cleanTranscriptText(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
  return value;
}

// These public factories provide the exact built-in renderers; execute is never called.
function builtinRenderers(cwd) {
  return new Map([createReadToolDefinition, createBashToolDefinition, createEditToolDefinition,
    createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition]
    .map(factory => {
      const original = factory(cwd);
      const definition = styleToolDefinition(original, { shellCommand: original.name === "bash" });
      return [definition.name, { renderShell: definition.renderShell,
        renderCall: definition.renderCall, renderResult: definition.renderResult }];
    }));
}

function recordedToolRenderer(name) {
  return styleToolDefinition({
    name: name || "tool",
    renderCall(args, theme, context) {
      const view = new Container();
      view.addChild(new Text(theme.fg(uiTone.toolTitle, theme.bold(name || "tool")), 0, 0));
      if (context.expanded) {
        view.addChild(new Markdown("```json\n" + JSON.stringify(args, null, 2) + "\n```", 0, 0, getMarkdownTheme()));
      } else {
        const summary = name === "finish_task" ? "Final report handoff · Ctrl+O for arguments" :
          `${Object.keys(args ?? {}).join(", ") || "No arguments"} · Ctrl+O to expand`;
        view.addChild(new Text(theme.fg(uiTone.body, summary), 0, 0));
      }
      return view;
    },
    renderResult(result, options, theme, context) {
      const output = (result.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
      if (name === "finish_task" && !context.isError) {
        return new Text(theme.fg(uiTone.body, "✓ Report handed to parent"), 0, 0);
      }
      const lines = output.split("\n");
      return new Text(options.expanded || lines.length <= 8 ? output : lines.slice(0, 8).join("\n") + "\n… Ctrl+O to expand", 0, 0);
    },
  });
}

export function createTranscriptRenderer(tui, cwd, getSharedRenderers = () => new Map()) {
  let previousLog, previousCwd, previousKey;
  let components = [];
  let previousExpanded, previousHideThinking;
  let tools = [];
  let assistants = [];
  let renderers = builtinRenderers(cwd);
  let sharedRenderers = new Map();

  function build(entry, log) {
    const workerCwd = entry.cwd || cwd;
    if (previousCwd !== workerCwd) renderers = builtinRenderers(workerCwd);
    previousCwd = workerCwd;
    components = [];
    previousExpanded = previousHideThinking = undefined;
    tools = [];
    assistants = [];
    const theme = getMarkdownTheme();
    const markdown = text => components.push(new Markdown(cleanTranscriptText(text), 0, 0, theme));
    const note = text => components.push(new Text(cleanTranscriptText(text), 0, 0));
    markdown("## Task\n\n" + (entry.contract?.objective || entry.goal || "No task description."));
    note(statusLine(entry));
    if (entry.error) markdown("## Error\n\n" + entry.error);
    markdown("\n---\n\n## Recorded activity");
    if (typeof log === "string") note(log);
    if (log?.notice) note(`[${log.notice}]`);
    const pending = new Map();
    let streaming;
    let report;
    const ensureTool = (id, name, args) => {
      if (!id) return;
      let component = pending.get(id);
      if (!component) {
        const shared = sharedRenderers.get(name);
        const renderer = shared?.renderCall || shared?.renderResult ? shared : renderers.get(name) || recordedToolRenderer(name);
        component = new ToolExecutionComponent(name || "tool", id, args || {}, { showImages: false },
          renderer, tui, workerCwd);
        pending.set(id, component);
        tools.push(component);
        components.push(component);
      } else if (args) component.updateArgs(args);
      return component;
    };
    const addAssistant = message => {
      const component = new AssistantMessageComponent(message, false, theme);
      components.push(component);
      assistants.push(component);
      return component;
    };
    for (const raw of log?.events ?? []) {
      const event = clean(raw);
      const message = event.message;
      if (event.type === "message_start" && message?.role === "assistant") {
        const initial = { ...message, content: Array.isArray(message.content) ? message.content : [] };
        streaming = { message: initial, component: addAssistant(initial) };
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (!update) continue;
        if (!streaming) {
          const initial = { role: "assistant", content: [] };
          streaming = { message: initial, component: addAssistant(initial) };
        }
        if (update.partial?.content) streaming.message = update.partial;
        else if (message?.role === "assistant" && Array.isArray(message.content)) streaming.message = message;
        else if (update.type === "text_delta" || update.type === "thinking_delta") {
          const type = update.type === "text_delta" ? "text" : "thinking";
          const content = streaming.message.content;
          let block = content.at(-1);
          if (!block || block.type !== type) { block = { type, [type]: "" }; content.push(block); }
          block[type] += update.delta ?? "";
        }
        streaming.component.updateContent(streaming.message, true);
      } else if (event.type === "message_end" && message) {
        if (message.role === "assistant" && Array.isArray(message.content)) {
          if (streaming) streaming.component.updateContent(message, false);
          else addAssistant(message);
          streaming = undefined;
          for (const content of message.content) {
            if (content.type === "toolCall") ensureTool(content.id, content.name, content.arguments);
          }
        } else if (message.role === "user") {
          const text = typeof message.content === "string" ? message.content :
            (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
          components.push(new UserMessageComponent(text, theme));
        } else if (message.role === "toolResult") {
          if (message.toolName === "finish_task" && !message.isError) report = message.details?.finishTask?.report || report;
          ensureTool(message.toolCallId, message.toolName)?.updateResult({ ...message, isError: Boolean(message.isError) });
        }
      } else if (event.type === "tool_execution_start") {
        const component = ensureTool(event.toolCallId, event.toolName, event.args);
        component?.setArgsComplete();
        component?.markExecutionStarted();
      } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const result = event.partialResult || event.result;
        if (event.toolName === "finish_task" && !event.isError && !result?.isError) report = result?.details?.finishTask?.report || report;
        if (result) ensureTool(event.toolCallId, event.toolName, event.args)?.updateResult(
          { ...result, isError: Boolean(event.isError || result.isError) }, event.type === "tool_execution_update");
      } else if (event.type === "worker_compaction") note(`Compaction: ${event.phase}`);
      else if (event.type === "worker_task_done") report = event.report;
    }
    if (entry.output || report) markdown("\n---\n\n## Final report\n\n" + (entry.output || report));
    else if (!log?.events?.length && typeof log !== "string") note("No recorded activity yet.");
  }

  return {
    render(entry, log, width, { expanded = false, hideThinking = false } = {}) {
      const key = JSON.stringify([entry.runId, entry.cwd, entry.contract?.objective || entry.goal, entry.output, entry.error, statusLine(entry)]);
      const shared = getSharedRenderers();
      const renderersChanged = shared.size !== sharedRenderers.size || [...shared].some(([name, value]) => sharedRenderers.get(name) !== value);
      sharedRenderers = shared;
      if (log !== previousLog || key !== previousKey || renderersChanged) {
        build(entry, log);
        previousLog = log;
        previousKey = key;
      }
      if (expanded !== previousExpanded) {
        for (const tool of tools) tool.setExpanded(expanded);
        previousExpanded = expanded;
      }
      if (hideThinking !== previousHideThinking) {
        for (const assistant of assistants) assistant.setHideThinkingBlock(hideThinking);
        previousHideThinking = hideThinking;
      }
      return components.flatMap(component => component.render(width));
    },
    invalidate() { for (const component of components) component.invalidate?.(); },
  };
}
