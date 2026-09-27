import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const DEFAULT_LIMITS = {
  max_parallel: 6, max_depth: 1, max_children: 3, max_nested_children: 1,
};

export function validateLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid subagents.json");
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_LIMITS, key))) throw new Error("Unknown subagent limit");
  const limits = { ...DEFAULT_LIMITS, ...value };
  for (const [key, max] of [["max_parallel", 64], ["max_depth", 8],
    ["max_children", 64], ["max_nested_children", 64]]) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > max) {
      throw new Error(`${key} must be an integer from 1 to ${max}`);
    }
  }
  return limits;
}

export function loadLimits(agentDir, inherited) {
  if (inherited !== undefined) return validateLimits(JSON.parse(inherited));
  try { return validateLimits(JSON.parse(readFileSync(join(agentDir, "subagents.json"), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return { ...DEFAULT_LIMITS }; throw error; }
}

export async function createPool(runsDir) {
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  return mkdtemp(join(runsDir, "pool-"));
}

// Atomic mkdir coordinates limits across independent pi processes. No waiting
// queue: reject at capacity so parents waiting for children cannot deadlock.
async function acquireSlotWithPrefix(pool, prefix, limit, signal, message) {
  signal?.throwIfAborted();
  for (let slot = 0; slot < limit; slot++) {
    signal?.throwIfAborted();
    const path = join(pool, `${prefix}${slot}`);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") continue; throw error; }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await rmdir(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    };
  }
  throw new Error(message ? `${message} (${limit})` :
    `Parallel worker limit reached (${limit} across the delegation tree)`);
}

export function acquireSlot(pool, limit, signal) {
  return acquireSlotWithPrefix(pool, "slot-", limit, signal);
}

// Parent identities can originate in inherited environment variables. Hashing
// them keeps the namespace inside the shared pool without using raw input as a
// path component. The root dispatcher has the stable "root" identity.
function parentPrefix(parentId) {
  const identity = parentId === "root" ? "root" :
    createHash("sha256").update(String(parentId ?? "")).digest("hex");
  return `parent-${identity}-slot-`;
}

export function acquireChildSlot(pool, parentId, limit, signal) {
  return acquireSlotWithPrefix(pool, parentPrefix(parentId), limit, signal, "Child limit reached");
}

// Acquire the parent-specific reservation first. If the shared reservation is
// unavailable, immediately return the parent reservation instead of leaving a
// phantom child slot behind.
export async function acquireWorkerSlots(pool, sharedLimit, parentId, parentLimit, signal) {
  const releaseParent = await acquireChildSlot(pool, parentId, parentLimit, signal);
  let releaseShared;
  try {
    releaseShared = await acquireSlot(pool, sharedLimit, signal);
  } catch (error) {
    await releaseParent();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let failure;
    for (const release of [releaseShared, releaseParent]) {
      try { await release(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };
}
