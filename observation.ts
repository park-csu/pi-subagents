import type { WorkerObservation } from "./worker-types.ts";

// Observation validity is independent of work status and time since the last event.
export function observationSnapshot(value, now = Date.now()): WorkerObservation {
  if (value === undefined) return { state: "unseen", lastEventAt: 0 };
  if (!value || !["unseen", "current", "invalid"].includes(value.state) ||
      !Number.isFinite(value.lastEventAt) || value.lastEventAt < 0) {
    return { state: "invalid", lastEventAt: 0 };
  }
  const lastEventAt = Math.min(value.lastEventAt, now);
  return { state: value.state, lastEventAt };
}

export function observationLabel(value, now = Date.now()) {
  if (value === undefined) return ""; // Older saved results have no observation metadata.
  switch (observationSnapshot(value, now).state) {
    case "unseen": return "Awaiting events";
    case "invalid": return "Invalid observation";
    default: return "";
  }
}
