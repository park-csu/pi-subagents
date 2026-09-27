export interface DelegationContract {
  objective: string;
  scope: { read: string[]; write: string[] };
  plan: string[];
  acceptance: string[];
  context?: string;
  constraints?: string[];
}

const fields = ["objective", "scope", "plan", "acceptance", "context", "constraints"];
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function strings(value: unknown, required = false): value is string[] {
  return Array.isArray(value) && value.length <= 64 && (!required || value.length > 0) && value.every(text);
}
export function validateContract(value: unknown): DelegationContract {
  const task = value as DelegationContract;
  if (!task || typeof task !== "object" || Array.isArray(task) || Object.keys(task).some(k => !fields.includes(k)) ||
      !text(task.objective) || !task.scope || typeof task.scope !== "object" || Array.isArray(task.scope) ||
      Object.keys(task.scope).some(k => !["read", "write"].includes(k)) ||
      !strings(task.scope.read) || !strings(task.scope.write) || !strings(task.plan, true) || !strings(task.acceptance, true) ||
      (task.context !== undefined && !text(task.context)) ||
      (task.constraints !== undefined && !strings(task.constraints))) {
    throw new Error("Task must be a JSON contract with objective, scope.read/write, plan and acceptance; all text must be nonempty");
  }
  if (task.scope.write.some(p => /[*?\[\]\n\r\0]/.test(p))) {
    throw new Error("scope.write requires literal file/directory paths, not globs or multiline descriptions");
  }
  if (Buffer.byteLength(JSON.stringify(task), "utf8") > 120000) throw new Error("Task contract exceeds 120KB");
  return structuredClone(task);
}

// Used for the worker prompt and the human-facing card. Tolerates partial tool
// arguments during streaming; validation happens before execution.
export function contractMarkdown(task: Partial<DelegationContract>, expanded = true): string {
  const lines = [String(task?.objective ?? "")];
  const list = (title: string, values: unknown, fallback = "") => {
    const items = Array.isArray(values) ? values.filter(v => typeof v === "string") : [];
    if (items.length || fallback) lines.push("", `**${title}**`, ...items.map(v => `- ${v}`), ...(items.length ? [] : [fallback]));
  };
  list("Write scope", task?.scope?.write, "Read-only — no file edits.");
  if (expanded) {
    list("Read scope / references", task?.scope?.read);
    if (task?.context) lines.push("", "**Context**", task.context);
    if (Array.isArray(task?.plan)) lines.push("", "**Plan**", ...task.plan.map((step, i) => `${i + 1}. ${step}`));
    list("Constraints", task?.constraints);
  }
  list("Acceptance", task?.acceptance);
  return lines.join("\n");
}
