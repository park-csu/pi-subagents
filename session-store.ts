import { open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { validateDefinition } from "./core.ts";
import { validateContract } from "./contract.ts";
import { validateLimits } from "./limits.ts";
import type { SavedLoadout } from "./worker-types.ts";

export function workerName(records, role, requested) {
  const base = requested ?? role;
  if (typeof base !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(base)) {
    throw new Error("Worker name must be 1–64 letters, digits, dots, underscores or hyphens");
  }
  if (requested && records.has(base)) throw new Error(`Worker name already exists: ${base}`);
  let name = base, suffix = 2;
  while (records.has(name)) name = `${base.slice(0, 54)}-${suffix++}`;
  return name;
}

// The parent's session ledger supplies the run directory, never a tool-supplied
// session path. Restores also reauthorize the role/tools against the live parent.
export async function readLoadout(runDir, runsRoot): Promise<SavedLoadout> {
  const root = await realpath(runsRoot);
  async function contained(path, maxSize = Infinity) {
    const file = await realpath(path);
    if (!file.startsWith(root + sep)) throw new Error("Session artifact escapes worker storage");
    const info = await stat(file);
    if (!info.isFile() || info.size > maxSize) throw new Error("Invalid or oversized session artifact");
    return file;
  }
  const file = await contained(join(runDir, "loadout.json"), 1024 * 1024);
  const data = JSON.parse(await readFile(file, "utf8"));
  if (data.version !== 2 || typeof data.task !== "string" || !data.task.trim() ||
      Buffer.byteLength(data.task) > 140000 || typeof data.cwd !== "string" || !isAbsolute(data.cwd) ||
      !Array.isArray(data.toolExtensions) || data.toolExtensions.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error("Unsupported or invalid saved worker loadout; start a new delegation");
  }
  const { systemPrompt, ...definition } = data.agent ?? {};
  const agent = validateDefinition(definition, systemPrompt ?? "", file);
  const limits = validateLimits(data.limits);
  const cwd = await realpath(data.cwd);
  const sessionFile = await contained(data.sessionFile);
  const handle = await open(sessionFile, "r");
  let header;
  try {
    const bytes = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    const end = text.indexOf("\n");
    if (end < 0) throw new Error("Session header missing");
    header = JSON.parse(text.slice(0, end));
  } finally { await handle.close(); }
  if (header.type !== "session" || typeof header.id !== "string" ||
      typeof header.cwd !== "string" || await realpath(header.cwd) !== cwd) {
    throw new Error("Saved session does not match its original working directory");
  }
  return { ...data, ...(data.contract === undefined ? {} : { contract: validateContract(data.contract) }), agent, limits, cwd, sessionFile };
}
