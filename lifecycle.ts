import type { WorkerPhase } from "./worker-types.ts";

const transitions: Record<WorkerPhase, readonly WorkerPhase[]> = {
  starting: ["running", "paused", "stopping", "ended"],
  running: ["paused", "stopping", "ended"],
  paused: ["running", "stopping", "ended"],
  stopping: ["ended"],
  ended: [],
};

export class WorkerLifecycle {
  #phase: WorkerPhase = "starting";

  get phase() { return this.#phase; }

  move(next: WorkerPhase) {
    if (!transitions[this.#phase].includes(next)) return false;
    this.#phase = next;
    return true;
  }
}
