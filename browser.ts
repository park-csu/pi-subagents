import { uiTone } from "ui-kit/appearance";
import { displayText, statusLine, workerStatus, workerSummary } from "./activity.ts";

// A view of owned runs: opening and closing it never replaces a Pi session.
export function createWorkerBrowser({ list, readLog, tui, theme, done, matchesKey, keybindings, truncate, wrap, transcript, measure = text => text.length, control, input }) {
  let selectedId;
  let detailId;
  let scroll = 0;
  let follow = true;
  let rows = 10;
  let totalLines = 0;
  let contentRows = rows;
  let log = "Loading recorded activity…";
  let expanded = false;
  let hideThinking = false;
  let disposed = false;
  let loading = false;
  let composing = false;
  let busy = false;
  let notice = "";
  const fg = (color, text) => theme?.fg ? theme.fg(color, text) : text;
  // Use Pi's active manager so reloads, multiple bindings and disabled actions agree.
  const key = (data, action, fallback) => keybindings
    ? keybindings.matches(data, action)
    : !!fallback && matchesKey(data, fallback);
  const hint = (action, fallback) => keybindings
    ? keybindings.getKeys(action).join("/") || "unbound"
    : fallback;
  const scrollHint = () => `${hint("tui.altScreen.pageUp", "pageUp")}/${hint("tui.altScreen.pageDown", "pageDown")} scroll · ${hint("tui.editor.cursorLineEnd", "end")} follow`;
  const getEntries = () => {
    const entries = list();
    if (!entries.some(entry => entry.runId === selectedId)) selectedId = entries[0]?.runId;
    return entries;
  };
  async function refresh() {
    if (disposed || loading) return;
    const id = detailId;
    const entry = getEntries().find(entry => entry.runId === id);
    if (entry) {
      loading = true;
      let next;
      try { next = await readLog(entry); }
      catch { next = "Log unavailable."; }
      finally { loading = false; }
      if (disposed) return;
      if (detailId === id) log = next;
    }
    if (!disposed) tui.requestRender();
  }
  const timer = setInterval(() => { void refresh(); }, 1000);
  timer.unref?.();
  function dispose() { disposed = true; clearInterval(timer); }
  async function act(action, message) {
    if (busy || !control || !detailId) return;
    const id = detailId;
    busy = true;
    notice = "Sending request…";
    tui.requestRender();
    try {
      const result = await control(id, action, message);
      if (disposed || detailId !== id) return;
      composing = false;
      if (input) { input.focused = false; input.setValue(""); }
      if (result?.runId && result.runId !== id) {
        selectedId = detailId = result.runId;
        log = "Loading recorded activity…";
      }
      notice = action === "pause" ? "Pause requested" : action === "resume" ? "Resume requested" : "Message delivered";
      void refresh();
    } catch (error) {
      if (!disposed && detailId === id) notice = `Request failed: ${displayText(error.message, 200)}`;
    } finally { busy = false; if (!disposed) tui.requestRender(); }
  }
  if (input) input.onSubmit = value => { if (value.trim()) void act("message", value); };
  return {
    dispose,
    invalidate() { transcript?.invalidate(); input?.invalidate(); },
    render(width) {
      width = Math.max(1, width);
      const innerWidth = Math.max(1, width - 4);
      const height = Math.max(7, Math.min(40, Math.floor((tui.terminal?.rows ?? 24) * 0.9)));
      rows = Math.max(1, height - 6);
      const entries = getEntries();
      let body;
      let title = "Subagents";
      let subtitle = workerSummary(entries) || "No worker sessions yet.";
      let footer = "↑↓ select · Enter details · Esc return to parent";
      if (detailId) {
        const entry = entries.find(entry => entry.runId === detailId);
        title = entry ? `Subagents / ${displayText(entry.agent || entry.name, 64)}` : "Subagents / Unavailable";
        subtitle = entry ? `${workerStatus(entry)} · ${displayText(entry.model, 100)} · ${displayText(entry.role, 40)}` : "This run is no longer available.";
        const sections = entry ? [
          "Task", entry.contract?.objective || entry.goal || "No task description.", "",
          "Activity", statusLine(entry),
          ...(entry.thinkingPreview ? [entry.thinkingPreview] : []),
          ...(entry.error ? ["", "Error", entry.error] : []),
          "", "Recorded activity", log,
          ...(entry.output ? ["", "Final report", entry.output] : []),
        ] : [];
        const lines = entry && transcript ? transcript.render(entry, log, innerWidth, { expanded, hideThinking }) : sections.flatMap(section => String(section).split("\n").flatMap(line => wrap(displayText(line, 6000), innerWidth)));
        totalLines = lines.length;
        contentRows = Math.max(1, rows - (notice && !composing ? 1 : 0));
        const end = Math.max(0, totalLines - contentRows);
        scroll = follow ? end : Math.min(scroll, end);
        body = lines.slice(scroll, scroll + contentRows);
        footer = `${scrollHint()} · ^O tools · ^T thinking · ← list · Esc back`;
        subtitle += ` · ${totalLines ? scroll + 1 : 0}–${Math.min(scroll + contentRows, totalLines)}/${totalLines}${follow ? " · Following" : ""}`;
        if (control) {
          const actions = [entry?.canMessage && "m message", entry?.canPause && "p pause", entry?.canResume && "r resume"].filter(Boolean);
          footer = [scrollHint(), ...actions, "^O tools", "^T thinking", "← list", "Esc back"].join(" · ");
        }
        if (composing) {
          body = ["Message worker", "Enter sends · Esc cancels", "", ...(input?.render(innerWidth) ?? []),
            "", notice];
          footer = busy ? "Sending… · Esc cancel editor" : "Enter send · Esc cancel editor";
        } else if (notice) body = [fg(uiTone.body, notice), ...body.slice(0, rows - 1)];
      } else {
        const index = entries.findIndex(entry => entry.runId === selectedId);
        const start = Math.max(0, index - rows + 1);
        body = entries.slice(start, start + rows).map(entry => {
          const elapsedMs = entry.status === "running" && !entry.restored && entry.startedAt ? Date.now() - entry.startedAt : entry.elapsedMs;
          const nested = entries.some(parent => parent.runId === entry.parentRunId) ? "  ↳ " : "";
          return fg(entry.runId === selectedId ? uiTone.selected : uiTone.title,
            `${entry.runId === selectedId ? "›" : " "} ${nested}${statusLine({ ...entry, elapsedMs })}`);
        });
        if (!body.length) body = ["Delegate a task to see it here.", "Use /subagents roles to list available roles."];
      }
      // Fill every terminal cell so the parent transcript cannot bleed through the overlay.
      const frame = line => {
        const text = truncate(line, innerWidth, "…");
        return fg(uiTone.border, "│") + " " + text + " ".repeat(Math.max(0, innerWidth - measure(text))) + " " + fg(uiTone.border, "│");
      };
      const edge = (left, right, label = "") => {
        const text = truncate(label, Math.max(1, width - 4), "…");
        return fg(uiTone.border, left + "─") + fg(uiTone.title, text) + fg(uiTone.border, "─".repeat(Math.max(0, width - 3 - measure(text))) + right);
      };
      return [edge("╭", "╮", ` ${title} `), frame(fg(uiTone.body, subtitle)), edge("├", "┤"),
        ...body.slice(0, rows).map(frame), ...Array(Math.max(0, rows - body.length)).fill("").map(frame),
        edge("├", "┤"), frame(fg(uiTone.secondary, footer)), edge("╰", "╯")]
        .map(line => truncate(line, width, "…"));
    },
    handleInput(data) {
      if (composing) {
        if (matchesKey(data, "escape")) { composing = false; input.focused = false; }
        else if (!busy) input.handleInput(data);
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "escape")) { dispose(); done(); return; }
      if (detailId) {
        const entry = getEntries().find(entry => entry.runId === detailId);
        if (control && !busy && data === "m" && entry?.canMessage && input) {
          composing = true; input.focused = true; notice = ""; tui.requestRender(); return;
        }
        if (control && !busy && data === "p" && entry?.canPause) { void act("pause"); return; }
        if (control && !busy && data === "r" && entry?.canResume) { void act("resume"); return; }
        if (matchesKey(data, "left")) { detailId = undefined; scroll = 0; }
        else if (matchesKey(data, "ctrl+o")) expanded = !expanded;
        else if (matchesKey(data, "ctrl+t")) hideThinking = !hideThinking;
        else if (key(data, "tui.editor.cursorLineEnd", "end")) follow = true;
        else if (key(data, "tui.editor.cursorLineStart", "home")) { follow = false; scroll = 0; }
        else {
          const delta = key(data, "tui.altScreen.pageUp", "pageUp") ? -contentRows :
            key(data, "tui.altScreen.pageDown", "pageDown") ? contentRows :
            key(data, "tui.altScreen.halfPageUp") ? -Math.max(1, Math.floor(contentRows / 2)) :
            key(data, "tui.altScreen.halfPageDown") ? Math.max(1, Math.floor(contentRows / 2)) :
            key(data, "tui.altScreen.lineUp") || key(data, "tui.select.up", "up") ? -1 :
            key(data, "tui.altScreen.lineDown") || key(data, "tui.select.down", "down") ? 1 : 0;
          if (delta) { follow = false; scroll = Math.max(0, Math.min(Math.max(0, totalLines - contentRows), scroll + delta)); }
        }
      } else {
        const entries = getEntries();
        const index = entries.findIndex(entry => entry.runId === selectedId);
        const delta = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
        if (delta && entries.length) selectedId = entries[Math.max(0, Math.min(entries.length - 1, index + delta))].runId;
        if (matchesKey(data, "enter") && selectedId) {
          detailId = selectedId;
          input?.setValue("");
          scroll = 0;
          follow = false;
          log = "Loading recorded activity…";
          notice = "";
          void refresh();
        }
      }
      tui.requestRender();
    },
  };
}
