import { uiTone, statusTone } from "ui-kit/appearance";
import { contractMarkdown } from "./contract.ts";
import { observationLabel } from "./observation.ts";
import { Box, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { displayText, progressLine, workerTree, workerLabel, styleWorkerLine } from "./activity.ts";
import type { WorkerStates } from "./state.ts";

const COMPLETION_PREVIEW_LINES = 10;
const COMPLETION_REPORT_CHARS = 12000;


function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => part?.type === "text").map(part => String(part.text ?? "")).join("\n");
}

function completionRecord(content, runId) {
  const text = messageText(content);
  const starts = [];
  const firstJson = text.search(/[\[{]/);
  if (firstJson >= 0) starts.push(firstJson);
  const arrayAfterLine = text.lastIndexOf("\n[");
  if (arrayAfterLine >= 0) starts.push(arrayAfterLine + 1);
  const objectAfterLine = text.lastIndexOf("\n{");
  if (objectAfterLine >= 0) starts.push(objectAfterLine + 1);
  for (const start of starts) {
    try {
      const parsed = JSON.parse(text.slice(start));
      const records = Array.isArray(parsed) ? parsed : [parsed];
      const record = records.find(value => value && typeof value === "object" &&
        (!runId || value.runId === runId));
      if (record) return record;
    } catch { /* The report may contain JSON-looking text. */ }
  }
  return undefined;
}

function safeReport(value) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    // Keep newlines and tabs for layout; replace the remaining controls so a
    // worker report cannot move the cursor or change the surrounding UI.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
}

function safeStatus(value) {
  const status = displayText(value, 32);
  return status || "completed";
}

function completionIcon(status) {
  switch (status) {
    case "paused": return "Ⅱ";
    case "running": return "◐";
    case "completed": return "✓";
    default: return "✗";
  }
}

function workerTitle(theme, name, status, mode = "") {
  return theme.fg(statusTone(status), `${completionIcon(status)} `) +
    theme.fg(uiTone.toolTitle, theme.bold(name)) +
    theme.fg(uiTone.secondary, ` · ${mode ? `${mode} · ` : ""}${status}`);
}

function completionBackground(status) {
  switch (status) {
    case "completed": return "toolSuccessBg";
    case "failed":
    case "cancelled": return "toolErrorBg";
    default: return "toolPendingBg";
  }
}

function completionMarkdownTheme(theme) {
  return {
    heading: text => theme.fg("mdHeading", text),
    link: text => theme.fg("mdLink", text),
    linkUrl: text => theme.fg("mdLinkUrl", text),
    code: text => theme.fg("mdCode", text),
    codeBlock: text => theme.fg("mdCodeBlock", text),
    codeBlockBorder: text => theme.fg("mdCodeBlockBorder", text),
    quote: text => theme.fg("mdQuote", text),
    quoteBorder: text => theme.fg("mdQuoteBorder", text),
    hr: text => theme.fg("mdHr", text),
    listBullet: text => theme.fg("mdListBullet", text),
    bold: text => (theme.bold?.(text) ?? text),
    italic: text => (theme.italic?.(text) ?? text),
    underline: text => (theme.underline?.(text) ?? text),
    strikethrough: text => (theme.strikethrough?.(text) ?? text),
    highlightCode: code => code.split("\n").map(line => theme.fg("mdCodeBlock", line)),
  };
}

/**
 * Completion messages contain a JSON payload for the next model turn. Keep
 * that payload model-visible, but render only its immutable report here.
 * In particular, do not look up WorkerStates: a resumed worker may have a
 * newer result under the same name while this historical card is visible.
 */
export function renderSubagentCompletion(message, options, theme) {
  const expanded = options?.expanded;
  const details = message?.details && typeof message.details === "object" ? message.details : {};
  const record = completionRecord(message?.content, details.runId);
  const status = safeStatus(details.status ?? record?.status);
  const name = workerLabel({
    agent: details.name ?? record?.name ?? "worker",
    role: details.role ?? record?.role,
  }) || "worker";
  const report = safeReport(record?.output);
  const boundedReport = report.slice(0, COMPLETION_REPORT_CHARS);
  const reportWasCharTruncated = boundedReport.length < report.length;
  const error = displayText(record?.error, 2000);
  const artifact = displayText(details.runDir ?? record?.runDir, 300);
  return {
    render: width => {
      if (width <= 0) return [];
      // Match the native tool card's one-column padding, shrinking it at the
      // narrowest widths because Box itself assumes a usable inner column.
      const cardPad = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
      const contentWidth = Math.max(1, width - cardPad * 2);
      const card = new Box(cardPad, 1, text => theme.bg(completionBackground(status), text));
      const title = workerTitle(theme, name, status);
      card.addChild(new Text(title, 0, 0));

      if (error) card.addChild(new Text(theme.fg(uiTone.error, `Error: ${error}`), 0, 0));

      let reportRows = [];
      if (boundedReport.trim()) {
        const markdown = new Markdown(boundedReport, 0, 0, completionMarkdownTheme(theme), {
          color: text => theme.fg(uiTone.title, text),
        });
        reportRows = markdown.render(contentWidth);
        if (reportRows.length === 1 && !reportRows[0].trim()) reportRows = [];
      }
      const shownReport = expanded ? reportRows : reportRows.slice(0, COMPLETION_PREVIEW_LINES);
      if (shownReport.length) card.addChild(new Text(shownReport.join("\n"), 0, 0));
      else if (!error) card.addChild(new Text(theme.fg(uiTone.secondary, "No report available"), 0, 0));

      const omittedRows = Math.max(0, reportRows.length - shownReport.length);
      if (!expanded && (omittedRows > 0 || reportWasCharTruncated)) {
        const omitted = omittedRows > 0 ? `${omittedRows} more report rows` : "more report content";
        card.addChild(new Text(theme.fg(uiTone.secondary, `… ${omitted} omitted; expand to view`), 0, 0));
      } else if (expanded && reportWasCharTruncated) {
        card.addChild(new Text(theme.fg(uiTone.secondary, "… report truncated for display; see the artifact for the full result"), 0, 0));
      }
      if (expanded && artifact) card.addChild(new Text(theme.fg(uiTone.secondary, `Artifacts: ${artifact}`), 0, 0));

      return card.render(width).map(line => truncateToWidth(line, width, ""));
    },
    invalidate() {},
  };
}

function contractCard(task, mode, parallelWork, theme, expanded, title, footer = "") {
  const markdown = contractMarkdown(task, expanded) +
    (mode === "async" && parallelWork ? `\n\n**Parent’s parallel work**\n${parallelWork}` : "");
  return {
    render(width) {
      if (width <= 0) return [];
      const rows = new Markdown(safeReport(markdown), 0, 0, completionMarkdownTheme(theme)).render(width);
      const shown = expanded ? rows : rows.slice(0, 14);
      const lines = [
        ...new Text(title(), 0, 0).render(width),
        ...shown,
        ...(!expanded ? [theme.fg(uiTone.secondary, rows.length > 14 ? "… expand for the full contract" : "Expand for plan and context")] : []),
        ...(footer ? ["", ...new Markdown(safeReport(footer), 0, 0, completionMarkdownTheme(theme)).render(width)] : []),
      ];
      return lines.map(line => truncateToWidth(line, width, ""));
    },
    invalidate() {},
  };
}

export function renderDelegateCall(args, theme, context) {
  if (context?.executionStarted) return { render: () => [], invalidate() {} };
  const mode = args.mode === "async" ? "async" : "sync";
  const title = () => theme.fg(uiTone.toolTitle, theme.bold(`delegate ${displayText(args.agent, 40)}`)) +
    theme.fg(uiTone.secondary, ` · ${mode}`);
  if (args.task && typeof args.task === "object") {
    return contractCard(args.task, mode, args.parallel_work, theme, false, title);
  }
  // Historical free-form calls remain readable.
  return new Text(title() +
    theme.fg(uiTone.body, ` · ${displayText(args.task ?? args.handoff?.goal, 128000)}`), 0, 0);
}

export function renderDelegateMessageCall(args, theme) {
  return {
    render(width) {
      if (width <= 0) return [];
      const title = new Text(theme.fg(uiTone.toolTitle,
        `delegate_message → ${displayText(args.name, 64)}`), 0, 0).render(width);
      const rows = new Text(theme.fg("toolOutput", safeReport(args.message)), 0, 0).render(width);
      return [
        ...title,
        ...rows.slice(0, 10),
        ...(rows.length > 10 ? [truncateToWidth(
          theme.fg(uiTone.secondary, `… ${rows.length - 10} more message rows omitted`), width, "…")] : []),
      ].map(line => truncateToWidth(line, width, ""));
    },
    invalidate() {},
  };
}

export function renderDelegateResult(result, { expanded, isPartial }, theme, context, states: WorkerStates) {
  const original = result.details;
  if (!original?.agent) return new Text(displayText(result.content?.[0]?.text, 500), 0, 0);
  if (context?.invalidate) states.invalidators.set(original.runId, context.invalidate);

  // Resolve lifecycle snapshots, never live progress: this card may be offscreen.
  const view = () => {
    const info = states.tree(original);
    info.role ??= context?.args?.agent;
    const contract = info.contract ?? (typeof context?.args?.task === "object" ? context.args.task : undefined);
    if (contract) {
      const mode = info.mode ?? context?.args?.mode ?? "sync";
      const title = () => workerTitle(theme, workerLabel(info), safeStatus(info.status), mode);
      const footer = [
        ...(info.error ? [`**Error:** ${displayText(info.error, 2000)}`] : []),
        ...(expanded && info.output ? ["**Worker report — pending parent verification**", String(info.output).slice(0, 12000)] : []),
        ...(expanded && info.runDir ? [`Artifacts: ${displayText(info.runDir, 300)}`] : []),
      ].join("\n\n");
      const card = contractCard(contract, mode, info.parallelWork ?? context?.args?.parallel_work, theme, expanded, title, footer);
      return { render: width => [...card.render(width),
        ...workerTree(info.descendants ?? [], { liveElapsed: false }).flatMap(line => new Text(line, 0, 0).render(width))], invalidate() {} };
    }
    if (!expanded) {
      const lines = workerTree([info, ...(info.descendants ?? [])], {
        // Lifecycle snapshots must not advance their clock on global repaint.
        liveElapsed: false,
        goalLimit: 128000,
        style: (line, worker) => styleWorkerLine(line, worker, theme),
      });
      return new Text(lines.join("\n"), 0, 0);
    }

    const running = info.status ? info.status === "running" : isPartial;
    const status = running ? "running" : info.status;
    let icon = "✗";
    if (status === "paused") icon = "Ⅱ";
    else if (status === "running") icon = "◐";
    else if (status === "completed") icon = "✓";

    const lines = [
      theme.fg(statusTone(status), `${icon} ${progressLine(info)}`),
      `Goal: ${displayText(info.goal, 128000)}`,
      theme.fg(uiTone.secondary, `${displayText(info.model)} / ${displayText(info.thinking)}`),
    ];
    const observation = observationLabel(info.observation);
    if (observation) lines.push(theme.fg(uiTone.body, `Observation: ${observation}`));
    if (running && info.thinkingPreview) {
      const thinking = displayText(info.thinkingPreview.slice(-800), 800);
      lines.push(theme.fg(uiTone.body, `Thinking: ${thinking}`));
    }
    if (info.error) lines.push(theme.fg(uiTone.error, info.error));
    if (info.descendants?.length) lines.push(...workerTree([info, ...info.descendants], { liveElapsed: false }));
    if (info.recent?.length) {
      lines.push("Recent activity:", ...info.recent.map(line => `  • ${displayText(line)}`));
    }
    if (!running) {
      const report = String(info.output ?? result.content?.[0]?.text ?? "").slice(0, 12000);
      lines.push("", "Worker report (not independent verification):",
        ...report.split("\n").map(line => displayText(line, 12000)));
    }
    if (info.runDir) lines.push(`Artifacts: ${displayText(info.runDir, 300)}`);
    return new Text(lines.join("\n"), 0, 0);
  };
  return { render: width => view().render(width), invalidate() {} };
}
