import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { displayText } from "./activity.ts";

const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 32000;

function textContent(content) {
  return (Array.isArray(content) ? content : []).flatMap(part => {
    if (part.type === "text") return [part.text ?? ""];
    if (part.type === "thinking") return [`Thinking: ${part.thinking ?? ""}`];
    return [];
  }).join("\n");
}

export function formatLogEvents(text, clipped = false) {
  const blocks = [];
  for (const line of text.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; } // Partial final records are retried on refresh.
    if (!event || typeof event !== "object") continue;
    if (event.type === "tool_execution_start") {
      blocks.push(`Tool: ${event.toolName ?? "unknown"}\n${JSON.stringify(event.args ?? {}, null, 2)}`);
    } else if (event.type === "message_end") {
      const message = event.message;
      if (!message || !["assistant", "user", "toolResult"].includes(message.role)) continue;
      const content = typeof message.content === "string" ? message.content : textContent(message.content);
      if (content) blocks.push(`${message.role === "toolResult" ? `Result: ${message.toolName ?? "tool"}` : message.role === "assistant" ? "Assistant" : "User"}\n${content}`);
    } else if (event.type === "worker_task_done") {
      blocks.push(`Report\n${event.report ?? ""}`);
    } else if (event.type === "worker_compaction") {
      blocks.push(`Compaction: ${event.phase ?? "unknown"}`);
    }
  }
  let output = blocks.slice(-80).map(block => block.length > 6000 ? block.slice(0, 6000) + "\n[Entry truncated]" : block).join("\n\n");
  clipped ||= blocks.length > 80 || output.length > MAX_TEXT;
  output = output.slice(-MAX_TEXT).split("\n").map(line => displayText(line, 6000)).join("\n");
  return (clipped ? "[Showing recent recorded activity]\n\n" : "") + (output || "No recorded activity yet.");
}

// Only read logs underneath this dispatcher's artifact root. Never resume the session.
export function parseLogEvents(text, clipped = false) {
  const events = [];
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event && ["message_start", "message_update", "message_end", "tool_execution_start",
        "tool_execution_update", "tool_execution_end", "worker_task_done", "worker_compaction"].includes(event.type)) events.push(event);
    } catch { /* Retry incomplete final records on the next refresh. */ }
  }
  return { events: events.slice(-2000), notice: clipped || events.length > 2000 ? "Showing recent recorded activity" : "" };
}

export function createLogReader(runsDir, { structured = false } = {}) {
  let cachedPath, cachedVersion, cachedText;
  return async (runDir) => {
    if (!runDir) return "Recorded log is not available for this worker.";
    try {
      const root = await realpath(runsDir);
      const path = await realpath(join(runDir, "events.jsonl"));
      if (!path.startsWith(root + sep)) return "Log unavailable: path is outside worker storage.";
      const file = await open(path, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile()) return "Log unavailable.";
        const version = `${stat.size}:${stat.mtimeMs}`;
        if (cachedPath === path && cachedVersion === version) return cachedText;
        const start = Math.max(0, stat.size - MAX_BYTES);
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        let text = buffer.subarray(0, bytesRead).toString("utf8");
        if (start) text = text.slice(text.indexOf("\n") + 1);
        cachedText = structured ? parseLogEvents(text, start > 0) : formatLogEvents(text, start > 0);
        cachedPath = path;
        cachedVersion = version;
        return cachedText;
      } finally { await file.close(); }
    } catch (error) {
      return error.code === "ENOENT" ? "No recorded activity yet." : "Log unavailable.";
    }
  };
}
