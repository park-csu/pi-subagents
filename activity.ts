import { uiTone, statusTone } from "ui-kit/appearance";
import { observationSnapshot, observationLabel } from "./observation.ts";
import type { WorkerPreview } from "./worker-types.ts";

// Bound and sanitize UI previews. Never render tool arguments or tool output.
export function displayText(value, limit = 100) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, limit);
}

export function toolActivity(name) {
  return displayText(name, 80);
}

export class ActivityTracker {
  constructor() {
    this.active = new Map();
    this.recent = [];
    this.phase = "Starting worker";
    this.thinking = "";
  }
  update(event) {
    if (event.type === "tool_execution_start") {
      const label = toolActivity(event.toolName);
      this.active.set(event.toolCallId, label);
      this.phase = label;
      this.thinking = "";
      this.recent.push(label);
      this.recent = this.recent.slice(-6);
    } else if (event.type === "tool_execution_end") {
      this.active.delete(event.toolCallId);
      // Keep the last meaningful activity while waiting for the model.
    } else if (event.type === "turn_start") {
      // A new turn is not observable work; retain the previous preview.
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "thinking_start") this.newThinkingBlock = true;
      else if (update?.type === "thinking_delta") {
        if (this.newThinkingBlock) this.thinking = "";
        this.newThinkingBlock = false;
        this.thinking = (this.thinking + String(update.delta ?? "")).slice(-800);
      } else if (update?.type === "thinking_end" && (this.newThinkingBlock || !this.thinking) && update.content) {
        this.thinking = String(update.content ?? "").slice(-800);
        this.newThinkingBlock = false;
      }
    } else {
      return false;
    }
    return true;
  }
  snapshot() {
    const labels = [...this.active.values()];
    return {
      activity: labels.length ? labels[0] + (labels.length > 1 ? ` (+${labels.length - 1} tools)` : "") : this.phase,
      thinkingPreview: labels.length ? "" : displayText(this.thinking, 800),
      recent: [...this.recent],
    };
  }
}

export function workerLabel(info) {
  const name = displayText(info.agent, 64);
  const role = displayText(info.role, 40);
  return role && role !== name ? `${name} (${role})` : name;
}

export function styleWorkerLine(line, info, theme) {
  if (!theme?.fg) return line;
  const tone = statusTone(info.status);
  const label = workerLabel(info);
  const start = label ? line.indexOf(label) : -1;
  if (start < 0) return theme.fg(uiTone.body, line);
  return theme.fg(tone, line.slice(0, start)) + theme.fg(uiTone.title, label) +
    theme.fg(uiTone.body, line.slice(start + label.length));
}

export function progressLine(info) {
  const seconds = Math.max(0, Math.floor((info.elapsedMs ?? 0) / 1000));
  const time = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const cost = info.usage?.cost?.total;
  return `${workerLabel(info)} · ${time} · ${info.turns ?? 0} turns` +
    (typeof cost === "number" && cost > 0 ? ` · ~$${cost.toFixed(3)}` : "") +
    ` · ${displayText(info.activity ?? "Starting worker")}`;
}

export function compactLine(info, goalLimit = 36, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((info.elapsedMs ?? 0) / 1000));
  const time = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  const activity = info.status && info.status !== "running"
    ? info.status
    : info.thinkingPreview ? `Thinking: ${info.thinkingPreview.slice(-240)}` : info.activity || "Starting";
  const observation = info.status === "running" ? observationLabel(info.observation, now) : "";
  const activityLabel = observation ? `${observation} · ${activity}` : activity;
  const goal = displayText(info.goal, goalLimit);
  const goalLabel = goal ? ` · ${goal}${displayText(info.goal, goalLimit + 1).length > goalLimit ? "…" : ""}` : "";
  return `${workerLabel(info)} ${time} ${info.turns ?? 0}t${goalLabel} · ${displayText(activityLabel, 260)}`;
}

export function singleLine(text, truncate) {
  return {
    render: (width) => [truncate(text, Math.max(0, width), "…")],
    invalidate() {},
  };
}

// A relay is display data only, not evidence of success, permission or billing.
export function workerPreview(info): WorkerPreview | undefined {
  if (!info || !/^[a-f0-9-]{36}$/.test(info.runId) ||
      (info.parentRunId && !/^[a-f0-9-]{36}$/.test(info.parentRunId))) return undefined;
  const statuses = ["running", "paused", "completed", "failed", "cancelled"];
  if (!statuses.includes(info.status)) return undefined;
  const finite = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    runId: info.runId, parentRunId: info.parentRunId || "",
    agent: displayText(info.agent, 40), goal: displayText(info.goal, 200),
    ...(info.role ? { role: displayText(info.role, 40) } : {}),
    model: displayText(info.model, 100), thinking: displayText(info.thinking, 20),
    status: info.status,
    ...(info.observation !== undefined ? { observation: observationSnapshot(info.observation) } : {}),
    activity: displayText(info.activity, 100),
    thinkingPreview: displayText(info.thinkingPreview, 800),
    startedAt: finite(info.startedAt), elapsedMs: finite(info.elapsedMs), turns: finite(info.turns),
    usage: { cost: { total: finite(info.usage?.cost?.total) } },
  };
}

export function workerTree(infos, { frame = 0, now = Date.now(), liveElapsed = true, goalLimit = 36, style = (line, _info) => line, format = compactLine } = {}) {
  // Older saved tool results predate run IDs and still need a visible row.
  const entries = new Map(infos.map((info, index) => {
    const runId = info.runId || `legacy-${index}`;
    return [runId, { ...info, runId }];
  }));
  const children = new Map();
  for (const info of entries.values()) {
    const parent = info.parentRunId && entries.has(info.parentRunId) ? info.parentRunId : "";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(info);
  }
  const lines = [];
  const seen = new Set();
  function visit(info, prefix, branch, continuation) {
    if (seen.has(info.runId)) return;
    seen.add(info.runId);
    const running = info.status === "running";
    const icon = running ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][frame % 10] : info.status === "paused" ? "Ⅱ" : info.status === "completed" ? "✓" : "✗";
    const elapsedMs = liveElapsed && running && info.startedAt ? now - info.startedAt : info.elapsedMs;
    lines.push(style(`${prefix}${branch}${icon} ${format({ ...info, elapsedMs }, goalLimit, now)}`, info));
    const nested = children.get(info.runId) ?? [];
    nested.forEach((child, i) => {
      const last = i === nested.length - 1;
      visit(child, prefix + continuation, last ? "└─ " : "├─ ", last ? "   " : "│  ");
    });
  }
  for (const root of children.get("") ?? []) visit(root, "", "", "");
  return lines;
}

export function workerStatus(info) {
  if (info.restored && ["running", "paused"].includes(info.status)) return "Not running";
  return ({ running: "Running", paused: "Paused", completed: "Completed", failed: "Failed", cancelled: "Cancelled" })[info.status] ?? "Unknown";
}

export function statusLine(info, _goalLimit = 0, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((info.elapsedMs ?? 0) / 1000));
  const time = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const current = info.status === "running" && !info.restored;
  const activity = current
    ? observationLabel(info.observation, now) || (info.thinkingPreview
      ? `Thinking: ${info.thinkingPreview.slice(-240)}` : info.activity || "Starting")
    : workerStatus(info);
  return `${workerLabel(info)} · ${time} · ${displayText(activity, 260)}`;
}

export function workerSummary(infos) {
  const counts = new Map();
  for (const info of infos) {
    const status = workerStatus(info).toLowerCase();
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
}

function isActiveWorker(info) {
  return info.status === "running" && !info.restored;
}

// Show only live work; full history remains available in /subagents.
export function workerPanelLines(infos, { frame = 0, now = Date.now(), theme, maxRows = 4 } = {}) {
  const active = infos.filter(isActiveWorker);
  if (!active.length) return [];
  const visible = active.slice(0, maxRows);
  const heading = `Subagents · ${workerSummary(active)}`;
  const lines = [theme?.fg ? theme.fg(uiTone.body, heading) : heading,
    ...workerTree(visible, { frame, now, format: statusLine,
      style: (line, info) => styleWorkerLine(line, info, theme) })];
  if (active.length > visible.length) lines.push(`  +${active.length - visible.length} more · /subagents`);
  return lines;
}

export interface WorkerPanelHost {
  upsert(panel: {
    id: string;
    order?: number;
    animated?: boolean;
    render(width: number, theme: unknown, timing: { now: number; frame: number }): string[];
  }): void;
  remove(id: string): void;
}

const WORKER_PANEL_ID = "subagents:workers";

// One parent-owned widget for the entire delegation forest. When a panel host
// is available, animation belongs to that host; the fallback timer only asks
// Pi to render the already-registered standalone component.
export class WorkerWidget {
  constructor({ tickMs = 120, settleMs = Infinity, truncate = (text, width) => text.slice(0, width) } = {}) {
    this.tickMs = tickMs;
    this.settleMs = settleMs;
    this.truncate = truncate;
    this.workers = new Map();
    this.frame = 0;
    this.panel = {
      id: WORKER_PANEL_ID,
      order: 200,
      animated: false,
      render: (width, theme, timing) => this.renderPanel(width, timing, theme),
    };
    this.fallback = {
      render: width => this.renderLines(width, Date.now(), this.frame),
      invalidate() {},
    };
    this.fallbackFactory = tui => {
      this.fallbackTui = tui;
      return this.fallback;
    };
  }

  start(ui, info) {
    this.setUI(ui);
    this.update(info);
  }

  setUI(ui) {
    if (this.ui === ui) {
      if (ui && !this.host && this.hasRunningWorkers()) this.ensureFallback();
      return;
    }
    if (this.fallbackVisible && this.ui) this.ui.setWidget("subagent-worker", undefined);
    this.stopAnimationTimer();
    this.fallbackVisible = false;
    this.fallbackTui = undefined;
    this.ui = ui;
    if (ui && !this.host && this.hasRunningWorkers()) this.ensureFallback();
  }

  attachHost(host) {
    if (!host || typeof host.upsert !== "function" || typeof host.remove !== "function") return false;
    if (this.host === host) return true;
    if (this.host) this.safeRemove(this.host);
    this.host = host;
    this.clearFallback();
    if (this.hasRunningWorkers()) this.safeUpsert(host);
    return true;
  }

  detachHost(host?) {
    if (host && this.host !== host) return false;
    const previous = this.host;
    this.host = undefined;
    if (previous) this.safeRemove(previous);
    if (this.ui && this.hasRunningWorkers()) this.ensureFallback();
    return true;
  }

  update(info) {
    const previous = this.workers.get(info.runId);
    this.workers.set(info.runId, {
      ...info,
      startedAt: info.startedAt || previous?.startedAt || Date.now(),
      // Repeated relay updates must not indefinitely extend settled entries.
      settledAt: ["running", "paused"].includes(info.status) ? undefined : previous?.settledAt ?? Date.now(),
    });
    if (this.workers.size > 256) {
      const parents = new Set([...this.workers.values()].map(row => row.parentRunId));
      for (const [id, row] of this.workers) {
        if (this.workers.size <= 256) break;
        if (!["running", "paused"].includes(row.status) && !parents.has(id)) this.workers.delete(id);
      }
    }
    this.draw();
  }

  draw() {
    const now = Date.now();
    this.prune(now);
    if (!this.hasRunningWorkers()) {
      if (this.host) {
        this.safeRemove(this.host);
      }
      this.clearFallback();
      this.scheduleSettlement(now);
      return;
    }
    this.panel.animated = this.hasRunningWorkers();
    if (this.host) {
      // Upsert the same panel object. The host owns animation and supplies
      // its current frame to render(); state changes still redraw immediately.
      this.safeUpsert(this.host);
    } else if (this.ui) {
      this.ensureFallback();
      this.requestRender();
    }
    this.scheduleSettlement(now);
  }

  finish(info) {
    this.update(info);
  }

  renderPanel(width, timing: { now?: number; frame?: number } = {}, theme = this.ui?.theme) {
    const now = Number.isFinite(timing?.now) ? timing.now : Date.now();
    const frame = Number.isFinite(timing?.frame) ? timing.frame : this.frame;
    return this.renderLines(width, now, frame, theme);
  }

  renderLines(width, now, frame, theme = this.ui?.theme) {
    const lines = workerPanelLines([...this.workers.values()], {
      frame, now, theme,
    });
    return lines.map(line => this.truncate(line, Math.max(0, width), "…"));
  }

  ensureFallback() {
    if (!this.ui || this.host || !this.hasRunningWorkers()) return;
    if (!this.fallbackVisible) {
      this.fallbackVisible = true;
      this.ui.setWidget("subagent-worker", this.fallbackFactory);
    }
    if (this.hasRunningWorkers()) this.startAnimationTimer();
    else this.stopAnimationTimer();
  }

  startAnimationTimer() {
    if (this.timer || !this.ui || this.host || !this.hasRunningWorkers()) return;
    this.timer = setInterval(() => {
      if (!this.ui || this.host || !this.fallbackVisible || !this.hasRunningWorkers()) {
        this.stopAnimationTimer();
        return;
      }
      this.frame++;
      this.draw();
      this.requestRender();
    }, this.tickMs);
    this.timer.unref?.();
  }

  stopAnimationTimer() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  clearFallback() {
    this.stopAnimationTimer();
    if (this.fallbackVisible && this.ui) this.ui.setWidget("subagent-worker", undefined);
    this.fallbackVisible = false;
    this.fallbackTui = undefined;
  }

  requestRender() {
    this.fallbackTui?.requestRender?.();
  }

  hasRunningWorkers() {
    return [...this.workers.values()].some(isActiveWorker);
  }

  prune(now) {
    const parents = new Set([...this.workers.values()].map(info => info.parentRunId));
    for (const [id, info] of this.workers) {
      // Keep ancestors while descendants are visible; never orphan tree rows.
      if (info.settledAt !== undefined && now - info.settledAt >= this.settleMs && !parents.has(id)) {
        this.workers.delete(id);
      }
    }
  }

  scheduleSettlement(now) {
    clearTimeout(this.settlementTimer);
    this.settlementTimer = undefined;
    const parents = new Set([...this.workers.values()].map(info => info.parentRunId));
    let deadline;
    for (const info of this.workers.values()) {
      if (info.settledAt === undefined || parents.has(info.runId)) continue;
      const candidate = info.settledAt + this.settleMs;
      deadline = deadline === undefined ? candidate : Math.min(deadline, candidate);
    }
    if (deadline === undefined || !Number.isFinite(deadline)) return;
    this.settlementTimer = setTimeout(() => {
      this.settlementTimer = undefined;
      this.draw();
    }, Math.max(0, deadline - now));
    this.settlementTimer.unref?.();
  }

  safeUpsert(host) {
    try { host.upsert(this.panel); } catch { /* A stopped host is stale. */ }
  }

  safeRemove(host) {
    try { host.remove(WORKER_PANEL_ID); } catch { /* A stopped host is stale. */ }
  }

  dispose() {
    this.clearFallback();
    clearTimeout(this.settlementTimer);
    this.settlementTimer = undefined;
    if (this.host) this.safeRemove(this.host);
    this.host = undefined;
    this.workers.clear();
    this.ui = undefined;
  }
}
