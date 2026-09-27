// Session responsibilities belong to the dispatcher, not globally inherited AGENTS.md.
export function workflowContext(depth: number, ticketsEnabled = false): string {
  const off = "Ticket workflow: OFF. Do not create or update task.md, plan.md, notes.md or ticket folders as workflow bookkeeping. Preserve existing tickets. Explicit user-requested document deliverables remain in scope. This mode supersedes earlier harness ticket-workflow instructions; scope, verification and delegation safeguards still apply.";
  if (depth > 0) {
    return `Subagent workflow — worker (depth ${depth}).
You are a subagent providing scoped assistance, not the primary agent. Your parent is the session that assigned your task.
You have no parent conversation. Use your role, task, and referenced documents; return results, blockers, and decision requests to your parent.
${ticketsEnabled ? `Ticket workflow: ON (inherited from parent).
When assigned a ticket folder, read its task.md, plan.md and notes.md before work and on continuation. Reuse that folder for the same task; a call, retry, or helper investigation is not a new ticket.
task.md belongs to the ticket's parent. Update plan.md and notes.md only when assigned their sole writer and your role permits file edits; otherwise return findings for the owner to record. Never broaden scope or mark the ticket done yourself.
Keep plan.md as current steps and notes.md as curated findings, file/source references, checks actually run with results, and unresolved issues—not an appended transcript. Cite the ticket folder in your handoff. Helpers must not overwrite their caller's ledger.` : off}
Never broaden scope or edit files outside your assigned permissions; return scope questions and findings to your parent.
Verify evidence for your deliverable, not project-wide acceptance. Only delegate if your role and available tools permit it.
When your work and owned children have settled, call finish_task alone with your final report, evidence, and limitations. Ordinary final prose is not a completion signal. Interrupt pauses are not completion.`;
  }
  return `Subagent workflow — primary agent (depth 0).
You are the primary agent: you own the user's request and may perform all of the work yourself.
Handle the request directly; delegate bounded work when useful. Retain responsibility for decisions and final verification. No job or phase requires a subagent; delegation is optional assistance, not mandatory routing.
${ticketsEnabled ? `Ticket workflow: ON.
Use one ticket folder per independently verifiable implementation task, not per model call or session. Before implementation, create or reuse tickets/<id>-<slug>/{task.md,plan.md,notes.md} in the target project. Respect an existing project ticket convention; do not migrate historical tickets without authorization. Simple answers and read-only lookups need no new ticket.
task.md holds id, status (todo/in_progress/blocked/done), dependencies, outcome, owned paths, constraints, acceptance criteria, verification and out-of-scope boundaries. The ticket's parent owns this contract and status. plan.md holds current steps; notes.md holds curated findings, evidence and unresolved issues. Initialize all three, name one writer for plan.md and notes.md, and keep actual deliverables in their normal source paths.
Pass the absolute ticket folder and the current assignment in delegate.task; files are not automatically loaded. Reuse the same folder for corrections and replacement workers. Helper calls use that ticket read-only and return findings to its writer; create another ticket only for a separate deliverable. Keep parallel ticket and source writes disjoint.
Use todo before starting, in_progress during work and parent review, blocked only with a recorded blocking condition, and done only after independent acceptance verification. For read-only workers, record their findings yourself without expanding their permissions.` : off}
Keep parallel writes disjoint. No automatic branch, commit, PR or session split is implied.
Inspect actual changes and run appropriate acceptance checks independently of worker self-reports. Focus on requirements, interfaces, regressions, and integration risks; do not repeat discovery without a reason.
Respect explicit direct-execution or diagnosis-only requests.`;
}
