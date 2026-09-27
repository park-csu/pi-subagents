import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function paneLayout(width, height, columns) {
  const widths = divide(width, columns.length, 20);
  let x = 0;
  const cells = columns.map((panes, column) => {
    const w = widths[column], heights = divide(height, panes.length, 3);
    let y = 0;
    const leaves = panes.map((pane, row) => {
      if (!/^%\d+$/.test(pane)) throw new Error("Invalid pane ID");
      const leaf = `${w}x${heights[row]},${x},${y},${pane.slice(1)}`;
      y += heights[row] + 1;
      return leaf;
    });
    const cell = leaves.length === 1 ? leaves[0] : `${w}x${height},${x},0[${leaves.join(",")}]`;
    x += w + 1;
    return cell;
  });
  const body = cells.length === 1 ? cells[0] : `${width}x${height},0,0{${cells.join(",")}}`;
  let checksum = 0;
  for (const char of body) {
    checksum = (checksum >> 1) | ((checksum & 1) << 15);
    checksum = (checksum + char.charCodeAt(0)) & 0xffff;
  }
  return `${checksum.toString(16).padStart(4, "0")},${body}`;
}
function divide(size, count, minimum) {
  const available = size - count + 1;
  if (!count || !Number.isInteger(size) || Math.floor(available / count) < minimum) {
    throw new Error("Window too small for worker panes");
  }
  return Array.from({ length: count }, (_, i) =>
    Math.floor(available / count) + (i < available % count ? 1 : 0));
}

// Cross-process layout lock: nested dispatchers share the root's existing pool.
// Stale locks fail closed to headless mode; never remove somebody else's lock.
async function locked(pool, operation) {
  const lock = join(pool, "tmux-layout-lock");
  const deadline = Date.now() + 2500;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

// Reserve a terminal, not a viewer. After layout is ready, tmux-worker replaces
// the silent placeholder with the launcher and Pi in tmux's terminal group.
export async function openWorkerPane({
  pool, runId, parentRunId = "", env = process.env, tmuxArgs = [], onError = () => {},
}) {
  const main = env.PI_SUBAGENT_TMUX_MAIN || env.TMUX_PANE;
  if (!env.TMUX || !/^%\d+$/.test(main ?? "")) return undefined;
  const command = (...args) => execFileSync("tmux", [...tmuxArgs, ...args], {
    encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  let pane, window;
  const resizeHook = `window-layout-changed[${parseInt(createHash("sha256").update(pool).digest("hex").slice(0, 7), 16)}]`;
  const rows = () => command("list-panes", "-t", window, "-F",
    "#{pane_id}|#{@pi_worker_pool}|#{@pi_worker_run}|#{@pi_worker_root}").split("\n")
    .map(line => { const [id, owner, run, root] = line.split("|"); return { id, owner, run, root }; });
  const batch = commands => command(...commands.flatMap((args, index) =>
    [...(index ? [";"] : []), ...args]));
  function checkedRows() {
    const all = rows();
    if (!all.some(p => p.id === main) || all.some(p => p.id !== main && p.owner !== pool)) {
      throw new Error("Unrelated tmux panes left untouched");
    }
    return all;
  }
  function arrangement(all, extra) {
    const workers = all.filter(p => p.id !== main);
    if (extra) workers.push(extra);
    const roots = [...new Set(workers.map(p => p.root))];
    const columns = [[main], ...roots.map(root => workers.filter(p => p.root === root).map(p => p.id))];
    const [width, height] = command("display-message", "-p", "-t", main,
      "#{window_width} #{window_height}").split(" ").map(Number);
    return { layout: paneLayout(width, height, columns), actual: all.map(p => p.id), desired: columns.flat() };
  }
  function swapCommands(actual, desired) {
    const commands = [];
    for (let i = 0; i < desired.length; i++) {
      if (actual[i] === desired[i]) continue;
      const other = actual.indexOf(desired[i]);
      if (other < 0) throw new Error("tmux pane layout changed during arrangement");
      commands.push(["swap-pane", "-d", "-s", desired[i], "-t", actual[i]]);
      [actual[i], actual[other]] = [actual[other], actual[i]];
    }
    return commands;
  }
  function arrange() {
    const all = checkedRows();
    const { layout, actual, desired } = arrangement(all);
    const commands = swapCommands(actual, desired);
    commands.push(["select-layout", "-t", window, layout]);
    batch(commands);
  }
  const removePane = () => {
    if (pane) {
      // Never kill an ID merely supplied by a model or recycled on another server.
      try {
        if (command("display-message", "-p", "-t", pane, "#{@pi_worker_run}") === runId) {
          // kill-pane immediately redistributes its space. Build the final
          // layout first and send all mutations in one tmux command queue so
          // the PTYs receive only the final resize.
          const all = rows();
          const killed = !parentRunId
            ? all.filter(p => p.id !== pane && p.owner === pool && p.root === runId).map(p => p.id)
            : [];
          // Descendant relays also stop on lost parent control. Remove any
          // remaining terminals while that process cleanup is settling.
          killed.push(pane);
          // A user pane may have appeared after this worker opened. Still
          // clean up our owned panes, but never apply our layout to that
          // window or swap its panes around.
          if (!all.some(p => p.id === main) || all.some(p => p.id !== main && p.owner !== pool)) {
            batch(killed.map(id => ["kill-pane", "-t", id]));
            return;
          }
          const remaining = all.filter(p => !killed.includes(p.id));
          const commands = killed.map(id => ["kill-pane", "-t", id]);
          if (!remaining.some(p => p.id !== main && p.owner === pool)) {
            commands.unshift(["set-hook", "-u", "-w", "-t", window, resizeHook]);
          }
          try {
            const { layout, actual, desired } = arrangement(remaining);
            commands.push(...swapCommands(actual, desired));
            commands.push(["select-layout", "-t", window, layout]);
          } catch { /* Still kill owned panes if the window is too small. */ }
          batch(commands);
          return;
        }
      } catch { /* Already closed. */ }
    }
    try { arrange(); } catch { /* Main/unrelated panes may have changed. */ }
  };
  const remove = () => {
    try { removePane(); }
    finally {
      try {
        if (!rows().some(p => p.id !== main && p.owner === pool)) {
          command("set-hook", "-u", "-w", "-t", window, resizeHook);
        }
      } catch { /* Window may already have closed. */ }
    }
  };
  try {
    return await locked(pool, () => {
      try {
        window = command("display-message", "-p", "-t", main, "#{window_id}");
        const all = rows();
        if (all.some(p => p.id !== main && p.owner !== pool)) throw new Error("Unrelated tmux panes left untouched");
        const parent = parentRunId ? all.find(p => p.run === parentRunId && p.owner === pool) : undefined;
        if (parentRunId && !parent) return undefined;
        // tmux can reflow a pane's grid even when its final PTY size is
        // unchanged. In that case the kernel sends no SIGWINCH. Notify the
        // current terminal groups after layout changes, including user resizes.
        const socket = command("display-message", "-p", "-t", main, "#{socket_path}");
        const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
        const notify = [process.execPath, fileURLToPath(new URL("./tmux-worker.mjs", import.meta.url)),
          "--resize", socket, window, pool, main].map(quote).join(" ");
        command("set-hook", "-w", "-t", window, resizeHook, `run-shell -b ${quote(notify)}`);
        // The pane ID is not known until split-window runs. A valid existing
        // pane ID is sufficient in a layout string: tmux assigns its leaves
        // in pane-list order, and arrange() swaps those leaves afterward.
        // Keeping split and select-layout in one command queue coalesces the
        // resize sent to existing PTYs.
        const { layout } = arrangement(all, { id: main, root: parent?.root ?? runId });
        let splitOutput;
        try {
          splitOutput = batch([
            ["split-window", "-d", "-P", "-F", "#{pane_id} #{pane_tty}",
              parent ? "-v" : "-h", "-t", parent?.id ?? main, "sleep 86400"],
            ["select-layout", "-t", window, layout],
          ]);
        } catch (error) {
          // split-window prints its pane before a later command can fail.
          // Recover that exact ID from this server's output so the untagged
          // placeholder cannot survive the failed startup.
          const output = typeof error.stdout === "string" ? error.stdout : error.stdout?.toString();
          const candidate = output?.trim().split(/\s+/);
          if (/^%\d+$/.test(candidate?.[0] ?? "")) {
            try { command("kill-pane", "-t", candidate[0]); } catch {}
          }
          throw error;
        }
        const result = splitOutput.split(/\s+/);
        pane = result[0];
        command("set-option", "-p", "-t", pane, "@pi_worker_run", runId);
        command("set-option", "-p", "-t", pane, "@pi_worker_pool", pool);
        command("set-option", "-p", "-t", pane, "@pi_worker_root", parent?.root ?? runId);
        arrange();
        let closed = false;
        return {
          pane, main,
          // Used to distinguish manual pane closure from a worker failure.
          size: () => {
            const size = command("display-message", "-p", "-t", pane, "#{pane_width} #{pane_height}");
            // tmux display-message can succeed with empty output for a dead target.
            if (!/^[1-9]\d* [1-9]\d*$/.test(size)) throw new Error("Worker pane closed");
            return size;
          },
          close: async () => {
            if (closed) return;
            closed = true;
            try { await locked(pool, remove); } catch { /* Fail closed on stale lock. */ }
          },
        };
      } catch (error) {
        remove();
        throw error;
      }
    });
  } catch (error) {
    try { onError(error instanceof Error ? error.message : String(error)); } catch { /* Detached UI. */ }
    return undefined;
  }
}
