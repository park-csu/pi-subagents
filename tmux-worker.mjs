// Keep Pi in tmux's terminal process group. The supervisor only relays the
// existing FD 3 events / FD 4 commands; it never renders into the worker TTY.
import { spawn, execFileSync } from "node:child_process";
import { createServer, createConnection, Socket } from "node:net";
import { rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const EXIT = "tmux_worker_exit";
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const writeEvents = bytes => {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(3, bytes, offset, bytes.length - offset);
};

function launch(path) {
  const socket = createConnection(path);
  // Stay alive while Pi handles TERM; relay disconnection escalates to KILL.
  process.on("SIGTERM", () => {});
  // tmux execs this launcher as its session/process-group leader. Pi and its
  // shell commands inherit that group, receiving native terminal resize events.
  const killGroup = () => {
    try { process.kill(-process.pid, "SIGKILL"); }
    finally { process.exit(2); }
  };
  socket.on("error", killGroup);
  socket.on("close", killGroup); // Never leave an unsupervised worker running.
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  let child;
  let finished = false;
  let needsNewline = false;
  const finish = (code, signal, error) => {
    if (finished) return;
    finished = true;
    if (needsNewline) socket.write("\n");
    socket.end(JSON.stringify({ type: EXIT, code, signal, error }) + "\n", killGroup);
  };
  lines.on("line", line => {
    if (!child) {
      try {
        const { command, args, cwd, env } = JSON.parse(line);
        child = spawn(command, args, {
          cwd, env, stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"],
        });
        child.stdio[3].pipe(socket, { end: false });
        child.stdio[3].on("data", bytes => {
          if (bytes.length) needsNewline = bytes[bytes.length - 1] !== 10;
        });
        child.stdio[4].on("error", () => {});
        child.stdio[4].resume();
        child.once("error", error => finish(2, null, error.message));
        child.once("close", (code, signal) => finish(code, signal));
      } catch (error) { finish(2, null, error.message); }
    } else {
      if (line === '{"type":"tmux_worker_terminate"}') process.kill(-process.pid, "SIGTERM");
      else child.stdio[4].write(line + "\n");
    }
  });
}

function supervise(pane, dir, command, args) {
  if (!/^%\d+$/.test(pane) || !process.env.TMUX) throw new Error("Missing worker pane");
  const path = join(dir, "ipc");
  const control = new Socket({ fd: 4, readable: true, writable: false });
  control.pause(); // Commands sent during startup stay buffered until connected.
  let connected = false;
  let socket;
  let exitReceived = false;
  let timer;
  const stop = code => {
    socket?.destroy();
    process.exit(code);
  };
  const server = createServer(client => {
    if (connected) { client.destroy(); return; }
    connected = true;
    socket = client;
    clearTimeout(timer);
    server.close();
    client.write(JSON.stringify({ command, args, cwd: process.cwd(), env: process.env }) + "\n");
    control.pipe(client, { end: false });
    // Forward chunks immediately, including unterminated records, so the
    // parent's existing byte limit still bounds the transport's input.
    client.on("data", bytes => {
      try { writeEvents(bytes); } catch { stop(2); }
    });
    const lines = createInterface({ input: client, crlfDelay: Infinity });
    lines.on("line", line => {
      try {
        const event = JSON.parse(line);
        if (event.type === EXIT) {
          exitReceived = true;
          if (event.error) process.stderr.write(event.error + "\n");
          stop(Number.isInteger(event.code) && event.code >= 0 && event.code <= 255 ? event.code : 2);
        }
      } catch { stop(2); }
    });
    client.on("error", () => stop(2));
    client.on("close", () => { if (!exitReceived) stop(2); });
  });
  process.on("exit", () => {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  });
  process.on("SIGTERM", () => {
    if (socket && !socket.destroyed) socket.write('{"type":"tmux_worker_terminate"}\n');
    else stop(143);
  });
  process.on("SIGINT", () => stop(130));
  control.on("end", () => stop(2));
  control.on("error", () => stop(2));
  server.on("error", () => stop(2));
  server.listen(path, () => {
    try {
      const tmuxSocket = process.env.TMUX.split(",").slice(0, -2).join(",");
      const shell = "exec " + [process.execPath, fileURLToPath(import.meta.url), "--launch", path].map(quote).join(" ");
      execFileSync("tmux", ["-S", tmuxSocket, "respawn-pane", "-k", "-t", pane, shell],
        { timeout: 2000, stdio: "pipe" });
      timer = setTimeout(() => stop(2), 10000);
    } catch (error) {
      process.stderr.write(`Cannot start worker in tmux: ${error.message}\n`);
      stop(2);
    }
  });
}

function resize(socket, window, pool, main) {
  try {
    const rows = execFileSync("tmux", ["-S", socket, "list-panes", "-t", window,
      "-F", "#{pane_id}|#{@pi_worker_pool}|#{pane_pid}"], { encoding: "utf8", timeout: 2000 })
      .trim().split("\n").map(line => line.split("|"));
    if (!rows.some(([id, owner]) => id !== main && owner === pool)) return;
    const pids = rows.filter(([id, owner]) => id === main || owner === pool).map(row => row[2]);
    // Resolve live terminal groups each time; never retain PIDs in a tmux hook.
    const groups = execFileSync("ps", ["-o", "tpgid=", "-p", pids.join(",")],
      { encoding: "utf8", timeout: 2000 }).trim().split(/\s+/).map(Number);
    for (const group of new Set(groups)) {
      if (Number.isSafeInteger(group) && group > 1) {
        try { process.kill(-group, "SIGWINCH"); } catch {}
      }
    }
  } catch { /* Window/panes may already have closed. */ }
}

const [mode, target, command, ...args] = process.argv.slice(2);
if (mode === "--launch") launch(target);
else if (mode === "--supervise") supervise(target, command, args[0], args.slice(1));
else if (mode === "--resize") resize(target, command, ...args);
else throw new Error("Invalid tmux worker mode");
