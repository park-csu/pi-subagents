/** Small request/response client for Pi's JSONL RPC transport. */
export function createWorkerRpc(write, timeoutMs = 15000) {
  let sequence = 0;
  let closed = false;
  const pending = new Map();
  return {
    request(command, ackType = "response") {
      if (closed) return Promise.reject(new Error("Worker has ended"));
      const id = `worker-${++sequence}`;
      if (typeof command === "function") command = command(id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Worker RPC ${command.type} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, ackType });
        try { write(JSON.stringify({ ...command, id }) + "\n"); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    receive(event) {
      if (!["response", "worker_control_result"].includes(event.type)) return false;
      const entry = pending.get(event.id);
      if (entry) {
        if (event.type !== entry.ackType && event.success) return true;
        pending.delete(event.id);
        clearTimeout(entry.timer);
        if (event.success) entry.resolve(event.data);
        else entry.reject(new Error(event.error || "Worker command failed"));
      }
      return true;
    },
    close() {
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Worker has ended"));
      }
      pending.clear();
    },
  };
}
