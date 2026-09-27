# Subagents

## Workflow context

This directory is also the `subagents` Pi package (`0.1.0`). It requires the
`ui-kit` peer package; install and load that shared host once alongside
`subagents` and OM rather than installing duplicate hosts.

**Primary agent** means the user-facing, depth-zero session that owns the user's
request and can do all the work directly. Delegation is optional assistance:
no job or phase requires a subagent. **Parent** means a subagent's immediate
caller. **Subagent** (also called a worker) means any delegated session, providing
scoped assistance in an implementation, investigation, review, or visual role.

`workflow.ts` supplies depth-specific instructions through `index.ts`'s
`before_agent_start` hook. Only the primary agent receives overall request ownership
and final verification duties. Every worker, including leaves without delegation tools,
receives its parent/task boundary instead. Role Markdown still supplies specialist
instructions; normal repository context is preserved. Global `AGENTS.md` contains
only general engineering guidance, so disabling the plugin does not leave its
delegation policy behind.

The callable-role list and capacity guidance are appended only for sessions
allowed to delegate. This prompt scoping does not change tool permissions or
resource limits. Do not copy primary-agent instructions into worker tasks.
Use `/reload` to refresh the current session; saved worker role prompts remain
part of their original loadout.

### Context economy

Keep tiny tasks, known-path reads, and simple lookups direct. Delegate only when
isolated investigation or useful parallel work outweighs startup and handoff cost,
not to meet a file-count quota.

Standing rules have separate homes: `AGENTS.md` contains general engineering
guidance; the plugin contains identity, handoff boundaries, and delegation
lifecycle/capacity guidance; role prompts contain specialist behavior; tasks
contain the objective, owned paths, task-specific constraints, and required checks.
Do not copy standing rules or entire conversations into each handoff.

Researcher fetches a known authoritative URL directly and searches for unknown
sources or evidence gaps. Narrow questions start with focused results/snippets
and one query-relevant fetch chunk, expanding when evidence is insufficient.
These are prompt guidelines, not new tool defaults, quotas, or permission changes.
Explicit task-specific requirements still apply.

Global definitions: `~/.pi/agent/subagents/*.md`. Run `/reload`, then `/subagents`.
The model calls `delegate({agent, task, mode?, parallel_work?, name?})` with a JSON task contract; users can run
`/subagent [--sync|--async] ROLE TASK` (default sync).
`callable: false` blocks the tool but permits the explicit command.
`can_delegate: false` removes the child delegation tool. Definitions require
name, description, provider/model, thinking, callable, can_delegate; the Markdown
body appends role instructions without removing the normal repository instructions.
`can_delegate: true` also requires a nonempty `delegatable_agents` array of exact
role names (up to 64). For example:

```yaml
can_delegate: true
delegatable_agents: [researcher]
```

With `can_delegate: false`, omit the list or use `[]`. Missing lists never mean
unrestricted delegation. Older saved delegating workers without an explicit
list cannot be restored; start a new delegation after updating the definition.
Required `tools` is an explicit list of currently active parent tools. Unknown fields and malformed values
are rejected. Only global definitions are loaded; project overrides are not supported.

Children run in separate headless pi RPC processes with no parent conversation, no auto-discovered
extensions/skills/templates, and no project configuration. Each worker saves its
own session and execution loadout for explicit restoration.
The dispatcher plus requested tools' registered source extensions are explicitly
loaded. Tool implementations are reused, not copied. Tools missing/inactive in
the parent or without a loadable source fail closed. The legacy shell approval
entry point is still loaded for saved loadout compatibility, but is now inert:
it registers no approval hook. Unrelated UI/memory extensions are not automatically loaded.
The child's active tools are checked before each model request; an extension
that adds unexpected tools causes failure. Global model/auth configuration remains
available. Roles use the currently configured openai-codex provider; change the
definition to your registered API provider if desired. Usage costs are estimates,
not necessarily your billed subscription/API charges.

## Parallel and nested execution

`mode: "sync"` is the default: the tool returns the report after `finish_task`
and worker cleanup. Use it when the next action depends on the result or there
is no useful independent work. Pauses retain the worker; they do not resolve a
synchronous call.

Choose `mode: "async"` explicitly for independent concurrent work. Model calls
must supply `parallel_work` describing the parent's independent work or the
independent siblings it will launch. Startup returns an acknowledgement;
completion arrives separately as a `subagent-completion` message. Do not repeat
the worker's investigation, edit its owned files, or start dependent integration
while it runs. This declaration guides the model; it cannot prove semantic
independence or prevent arbitrary parent shell commands.

Every model-issued delegation uses a JSON execution contract. The tool validates
it before launch, saves it in `loadout.json`, and presents it as a Markdown card.
Collapsed cards show the objective, write scope and acceptance; expand for the
plan, references, constraints, and returned report. The worker receives a
Markdown rendering of the same contract. Referenced files are not loaded
implicitly. This contract applies with `/tickets` on or off; `/tickets` still
controls optional Markdown workflow files only.

```json
{
  "agent": "implementer",
  "mode": "sync",
  "task": {
    "objective": "Fix expired-session handling",
    "scope": {
      "read": ["src/auth.ts", "tests/auth.test.ts"],
      "write": ["src/auth.ts", "tests/auth.test.ts"]
    },
    "plan": ["Reproduce the expiry failure", "Fix the handler and run the regression test"],
    "acceptance": ["Expired sessions are rejected", "Auth regression tests pass"],
    "constraints": ["Preserve the public API"]
  }
}
```

Required fields are `objective`, `scope.read`, `scope.write`, `plan`, and
`acceptance`. Optional `context` and `constraints` hold additional instructions.
Use an empty write array for read-only work. Write scopes are literal files or
directories, relative to cwd or absolute; globs are rejected. The dispatcher
rejects overlapping declared write scopes among active workers, including
paused workers, directory descendants and existing symlink aliases. This is
coordination within one dispatcher, not filesystem access enforcement or a
cross-process lock for nested dispatchers. Manual free-text commands and older
saved sessions have no structured write scope.

Manual `--async` is an explicit user choice and does not require
`parallel_work`. `delegate_message` remains an immediate steering/restoration
operation; its eventual result arrives separately. Existing saved loadouts
without a contract remain restorable under their original restrictions.

TUI and headless parents remain alive while they own children, including
between turns. Top-level `pi -p` sessions wait through the completion-triggered
final turn in text and JSON modes. Fast workers notify independently of slower
siblings; synchronous calls return their report without a duplicate completion
notification.

### Addressing and restoring workers

An optional `name` assigns a session-local worker name; otherwise names receive
unique role-based suffixes. With user authorization, call
`delegate_message({name, message})`, or use `/subagent-message NAME MESSAGE`.
Messages steer running workers, resume paused workers, or restore ended workers
from their actual saved Pi conversation. These operations acknowledge startup
or delivery rather than awaiting completion. Routine A2A chatter is not enabled.

Restoration retains the original contract, cwd, model, thinking and tool loadout,
reauthorizes against current definitions and active tools, and clamps saved
limits to current limits. It does not merely launch a fresh worker with the same
name. Only names recorded in this parent session can be addressed. Old artifacts
without a supported loadout cannot be restored. Live continuation retains its
existing process/session state; restarting an ended session creates a new worker
process.
Concurrent use of a session file is blocked by an ownership lock. A crash may
leave `session.jsonl.lock`; remove it only after confirming its owner is gone.
Parent session switching/forking is blocked while workers are owned.

`~/.pi/agent/subagents.json` configures:

```json
{
  "max_parallel": 6,
  "max_depth": 1,
  "max_children": 3
}
```

`max_parallel` is the **shared active-worker cap**, including parents waiting
for children, across one primary agent's entire delegation tree. It is not a
per-parent limit and not a lifetime call budget. Multiple ordinary `delegate`
calls run concurrently; no batch API or waiting queue is needed. Calls at
capacity fail immediately, avoiding deadlock when parents hold slots while
requesting children.

`max_children` limits the primary agent's active direct workers. Paused workers
retain their slots. The default depth is one, so only the primary agent can
delegate and at most three workers run concurrently:

```text
primary agent
├─ worker A
├─ worker B
└─ worker C
```

A fourth worker is rejected immediately, even if shared slots remain free.
All installed roles, including implementer, have `can_delegate: false`.

The primary agent is depth 0 and its workers are depth 1. At the configured depth
ceiling a worker receives neither `delegate` nor `delegate_message`. The engine
still supports deeper trees if a future configuration raises `max_depth` and a
role explicitly permits delegation. `max_nested_children` then limits each
worker's direct children; its default is one. Revoking a role's delegation
permission prevents restoration of saved loadouts that still require it.

Valid values: max_parallel/max_children/max_nested_children 1–64, max_depth 1–8. Missing keys use the above
defaults; malformed/unknown keys are rejected. Run `/reload` after changes.
Children inherit a fixed configuration snapshot rather than rereading a changed
global file. `/subagents` displays the active limits.

Atomic filesystem slots coordinate both shared and parent-local caps across processes. Limits
and process groups are operational guards, NOT security sandboxes. Parallel
writes are not automatically isolated: use disjoint scopes or separate worktrees.
No role-specific serialization is imposed.

Workers have no overall execution-time or turn-count limit. Explicit
cancellation, output safety limits, and the configured concurrency/depth limits
remain in effect. Other limits include the 16 MiB event stream and
12000-character parent result. There is no durable aggregate spend/call budget
yet.
Completion messages and result.json record aggregate worker usage. Startup
acknowledgements cannot include future usage; custom completion messages are not
guaranteed to contribute to Pi's native footer/session totals. Inspect artifacts
for cost; there is no durable aggregate billing ledger.
Synchronous delegate responses include aggregate worker usage as tool usage.
Escape interrupts the Pi turn and retains the worker session; see below.
Shutdown cancels both running and paused children.
On POSIX, headless top-level workers own process groups; headless nested workers
inherit them. Each tmux worker instead runs in its own pane's terminal group.
Hard cancellation sends TERM, then disconnects/kills after the grace period;
a disconnected tmux launcher kills its group, and lost parent control channels
also stop nested relays. Shutdown awaits owned calls. Normal completion also kills
leftover group members. This does not contain commands that deliberately detach
into new process groups; Windows process-tree cleanup is not implemented.
Abrupt SIGKILL/crashes can leave reserved filesystem slots; these fail closed
(reduced available capacity) until a new session or `/reload` creates a fresh
pool. Do not manually clear a pool while its workers are running.

Private local artifacts are under `~/.pi/agent/subagent-runs/` (ignored by Git).
They may include sensitive source and tool output; do not publish them. Clean them
manually when no longer needed.

## Deliberate boundaries

This is the dispatch layer, NOT the full implementation harness. No automatic
worktree, approval ledger, protected tests, budget ledger, or
integration is implemented yet. `completed` means the child returned successfully,
not that the task is correct or approved.

The implementer writes in the CURRENT cwd. Use a prepared worktree manually when
needed. Child processes/worktrees are not security sandboxes. An agent with bash
can bypass prompt/tool policy by launching programs or touching arbitrary paths.
No profile provides a confidentiality sandbox. Do not use this layer for
untrusted code without OS isolation.

The primary agent handles the request directly and retains responsibility for
decisions and final verification. When useful, it can delegate bounded assistance:
implementer for assigned edits/tests, scout for local discovery, or researcher
for external evidence. Implementer may also delegate discovery within its task.
No job is bound to a role and delegation is not a quota. Workers return scope or contract questions
to their parent rather than silently expanding work. There is no `ask_question` tool.

The current profiles require these active parent tools:

| Role | Tools |
| --- | --- |
| implementer | read, bash, apply_patch, web_search, web_fetch |
| scout | read, bash |
| researcher | read, bash, web_search, web_fetch |
| reviewer | read, bash |

Implementer uses its web tools directly when assigned work needs external
sources. Model and thinking settings remain in each definition. Reviewer is
manual-only, not part of automatic verification. The primary agent may own
three active workers; the shared limit of six cannot be reached at depth one.

Scout/research/review no-edit rules are prompt policy, NOT filesystem enforcement:
bash can write files. Review tests may create artifacts. Web use consumes Tavily
credits; those are not included in model token costs.

## Optional ticket files and manual tasks

Ticket bookkeeping is **off by default**. The primary session controls it with:

- `/tickets` — show the selected mode.
- `/tickets on` — require the ticket workflow below.
- `/tickets off` — stop workflow ticket creation/updates; existing files are preserved.

The selection is saved as a context-free session entry and restored on reload,
resume, fork, and tree navigation from the active branch. New sessions (and old
sessions without a selection) default to off. A change during an agent run takes
effect at the next `before_agent_start`, not halfway through the current run.
Idle manual worker launches use the selected mode. New and restored workers
inherit the parent's mode at launch, including nested workers; live workers
retain their snapshot and cannot run `/tickets` themselves. Thus a restarted
worker may use a different documentation mode than its earlier invocation.

Off mode does not disable scope boundaries, acceptance checks, tool permissions,
worker lifecycle or concurrency limits. Explicitly requested document deliverables
are still allowed. This is prompt policy, not filesystem enforcement.

With tickets on, implementation work uses **one ticket folder per task**, not one per invocation:
`tickets/<id>-<slug>/{task.md,plan.md,notes.md}` in the target project. The parent
owns the contract/status in `task.md` and assigns one writer for the current plan
and notes. Corrections, replacement workers and helper calls reuse that folder.
Read-only helpers return findings rather than editing the ledger. The parent
marks `done` only after acceptance review; `finish_task` still only hands off a
worker report. Existing project ticket conventions take precedence.
See [ticket workflow and templates](../../tickets/README.md) for ownership,
lifecycle and examples. This is prompt policy, not automatic file creation or
validation; the dispatcher API and private run artifacts are unchanged.

When ticket files exist, put their paths in the JSON contract's `scope.read`,
include only assigned writable paths in `scope.write`, and state the current
assignment in `objective`. The worker reads references with its authorized tools.
Do not replace the structured contract with a JSON-encoded string or a filename.
The JSON contract is limited to 120,000 UTF-8 bytes and rejects unknown fields;
the generated worker prompt is also subject to the existing 128KB limit.

For manual use: `/subagent --sync implementer Implement the parser; read docs/parser.md`.
Manual text remains free-form and is limited to 128,000 UTF-8 bytes. The prompt
is saved privately in `handoff.txt`; model-issued contracts are additionally
saved as JSON in `loadout.json`. Existing saved worker sessions can still be
continued through `delegate_message`; their original task and current
role/model/tool authorization checks remain in effect.

Use focused prompts rather than entire conversations. Keep constraints explicit,
separate observations from hypotheses and request concise evidence, check results
and remaining risks. Worker reports are not machine-validated acceptance results.
Optional behavior presets live in the sibling `prompt-snippets` extension
(`/snippets` or Alt+S); they add instructions without changing tool permissions.

## Offline checks

```sh
node --test extensions/subagents/*.test.mjs
```

`rpc.test.mjs` exercises the current headless launch path with real Pi worker
processes and a network-blocked provider: startup, steering, repeated pause and
resume, nested sync/async controls, completion and cleanup. `profiles.test.mjs`
checks role capabilities without pinning a particular configured model or
thinking level. `workflow.test.mjs` checks the depth-scoped prompt; global
`AGENTS.md` may contain general delegation guidance.
The explicit JSON and tmux transports remain covered as legacy compatibility
paths, not as the dispatcher's default.

The integration check uses the installed pi extension loader plus a fake `pi`
executable: four real dispatcher calls each launch two nested fixtures, exercising
the global pool, depth/tool gate, progress relay, usage aggregation and Unicode
tree without making model/API calls. That legacy stress fixture explicitly
overrides the child limits to 4/2; limiter tests separately verify the default
the configured direct and nested slot behavior, rejection and slot release.
It auto-detects pi on PATH or accepts
`PI_TEST_PACKAGE_ROOT`; it skips when pi is unavailable or on Windows.

Based on the installed pi `examples/extensions/subagent` process pattern.

`native-async.test.mjs` additionally runs the actual Pi engine with a deterministic,
network-blocked provider. It verifies depth-zero text/JSON parents without supervisor
FDs, nested headless parent retention, a later child completion triggering the
parent's final turn, and restoration of real saved conversation history.
The dispatcher fixture also tests named restoration and
live steering; session-store tests cover invalid schemas and escaping paths.

## Live observability

The parent TUI shows an OM-style combined worker widget, **one width-truncated
line per worker**: elapsed time, completed turns, a short goal and last meaningful
activity. Nested workers use Unicode `├─`, `└─`, `│` connectors, without a
"delegated from" label:

```text
◐ researcher 12s 2t · Main question · delegate
├─ ◐ researcher 7s 1t · Subquestion A · web_search
└─ ◐ researcher 5s 1t · Subquestion B · Thinking: …
```

Lifecycle snapshots of the same tree appear in the message result; its primary task is shown
in full (within the 128KB task bound), wrapping instead of truncating at the
terminal edge. Descendant relay previews remain bounded to 200 goal characters.
The duplicate call header is hidden once execution starts. The bottom widget
shows a status-count header and up to four worker rows, prioritizing active work.
Each row shows the name, elapsed time, and last tool call or thinking preview;
long previews are truncated to the terminal width. Additional workers are counted
in a final `/subagents` hint. Only running, non-restored workers appear in the
live panel; finished and paused rows leave it immediately. Their history remains
available through `/subagents` (up to 256 retained rows where possible). Model/thinking
settings, cost and full reports remain in the expanded tool view.
The indicator updates without adding messages or model calls.
It does not replace OM's widget or the existing footer.

`/subagents` opens a framed native Pi overlay listing current and retained workers.
Its width is capped at 120 columns, with padded rows, section dividers and a
scroll-position indicator separating worker content from the parent transcript.
Use Up/Down to select, Enter for details, Left to return to the list, and Escape
to return directly to the parent. Closing the overlay does not interrupt workers.
The detail view shows the task, activity, recorded log and final report. It refreshes
every second while open. Messages reuse Pi's native Markdown and syntax highlighting;
built-in tools reuse Pi's tool-call and result components. Ctrl+O expands tool
results; Ctrl+T toggles thinking. Our extensions register every tool through
`ui-kit/tools`, sharing their original call/result renderers with this viewer.
Tools whose renderers are unavailable in the parent show a compact call summary
and expand arguments as highlighted JSON using Pi components. `finish_task` shows a compact
handoff status with the Markdown report in its own section. Images are
not rendered in this view. Home jumps to the top; End follows the latest output;
Up/Down and Page Up/Page Down scroll without following. The detail view reads Pi's
active `keybindings.json` mappings: `tui.altScreen.pageUp/pageDown`,
`halfPageUp/halfPageDown`, and `lineUp/lineDown` control transcript scrolling;
`tui.select.up/down` also move one line. `tui.editor.cursorLineStart/cursorLineEnd`
jump to the top and follow the latest output. Configured keys replace defaults,
and an empty array disables that action. The footer displays configured page and
follow keys. For example, add these entries to `~/.pi/agent/keybindings.json`
and run `/reload`:

```json
{
  "tui.altScreen.halfPageUp": "ctrl+u",
  "tui.altScreen.halfPageDown": "ctrl+d"
}
```

These shared actions also apply in Pi's fullscreen transcript. While composing a
worker message, the native input retains its editing keybindings.
Logs show a bounded recent
slice of the recorded events, with truncation indicated. Nested workers whose log
path is not available still expose their relayed status and activity. Restored
historical running/paused entries are labeled `Not running` until a live execution
is available. `/subagents roles` lists role definitions and capacity limits.

The detail view also provides message, pause and resume controls described below.
Controls are available only while this dispatcher owns the run or can restore its saved session.


Activity uses literal tool names from tool start/end events, without per-tool
label mappings or argument previews. These indicate invocation, not success.
Work status (`running`, `paused`, terminal outcomes) is independent of observation
state (`unseen`, `current`, `invalid`). Valid incoming events update
`observation.lastEventAt`. `current` means a valid observation has been received;
it does not assert that the worker is making progress. Silence does not change
observation state or work status, and there is no time-based observation warning.
Invalid observation metadata is display-only; invalid/missing lifecycle values
in relayed previews are rejected, never coerced to `running`. Malformed
execution-protocol JSON still fails the worker as before.
Between tool calls, actual provider thinking blocks are shown as a bounded tail
(240 characters collapsed/widget, 800 expanded). No model-generated summaries
or inferred reasoning are used. Waiting/generating-output events do not replace
the last thinking block or tool name. Until either is available, "Starting" is
shown. Thinking and goals can contain sensitive information; do not
screen-share indiscriminately. Raw commands, URL arguments and tool outputs
are not used for activity previews.
Concurrent child tools are tracked by call ID. Only six recent tool activities
are retained in the UI; full events remain in the private log.

The delegate tool card expands to show model/thinking, recent activity, worker
report and artifact path. Reports are explicitly not independent verification.
Terminal states distinguish completed, failed and cancelled. Manual calls share
the widget but retain the normal custom-message result display. Automated tests
cover metadata, stream handling and cleanup;
actual interactive appearance should be checked after /reload.

Nested progress travels over private FD 3, including after the original tool
acknowledgement has returned. Native `tool_execution_update` partial-result
details and `tool_execution_end` result details remain supported.
No custom stdout writes are used: pi redirects ordinary extension stdout to
stderr in JSON and RPC modes. The integration fixture reproduces this redirection.
This relay does not count toward model usage or authorize
actions. Each parent card retains at most 256 descendant summaries. Final tool
completion reports carry aggregate token usage; interrupted runs may lack final
nested usage.

## Headless RPC workers

Workers start with `pi --mode rpc` in both interactive and headless parents.
They do not open tmux panes. The parent sends the initial prompt on stdin and
reads Pi's JSONL events on stdout. The existing private FD 3 carries lifecycle,
completion and descendant progress; FD 4 still detects loss of the supervisor.
All streams share the existing output limit and process cleanup policy.

Controls use RPC prompts addressed to the worker-only `/worker-control` extension
command. Pi executes that command before model input, including during an active
turn. Each control carries a request ID and receives its own success/error
acknowledgement; an RPC prompt acceptance alone is not treated as control success.
No control instruction is sent to the model. Requests time out after 15 seconds.
Interactive extension questions in a worker are cancelled instead of waiting for
an invisible dialog. Use the parent session for user questions.

`/subagents` details expose these controls for owned workers:

- `m`: open the native input, then Enter to send or Escape to cancel editing.
  Running workers receive steering; paused workers resume with the message.
- `p`: pause the selected worker and its owned descendants, retaining their
  processes, sessions and concurrency slots.
- `r`: resume a paused worker. For a saved, ended worker, start a new execution
  using its recorded session and original contract, subject to current permissions
  and capacity. The viewer follows the new run ID.
- Escape outside the input returns to the parent without interrupting work.

Controls route through the owning parent for descendants. The dispatcher validates
ownership at every hop. Historical descendants whose parent is no longer active
remain available for inspection, but cannot be controlled through that old route.
Failed messages retain their draft; command errors appear in the view.

Main Escape pauses active workers. `continue`, `resume`, `계속` or `재개` in the
parent resumes paused roots and their owned children. Unrelated prompts do not
restart paused work. `finish_task` still ends a successful execution only after
owned children settle. The sync delegate call remains pending while paused.
Main shutdown, `/reload`, or hard resource failures terminate workers and release
resources. Live processes do not survive a restart; saved direct workers can be
continued from the browser or `/subagent-message`.

The legacy tmux transport and JSON fixture transport remain for compatibility
checks through explicit internal options. The dispatcher always uses RPC;
`TMUX` and `TMUX_PANE` do not affect normal worker startup.

`rpc.test.mjs` uses the installed Pi engine with a provider that cannot access the
network. It checks steering, repeated pause/resume, owned-descendant controls,
request errors, session retention and cleanup. `native-async.test.mjs` verifies
nested sync/async completion and saved-session restoration.

### Compaction versus interrupt

Compaction settings are unchanged. The worker lifecycle bridge tracks native compaction
hooks separately from explicit Escape/supervisor interrupts. Native automatic
compaction owns its own continuation (no extra prompt is injected). Manual
compaction that interrupted active work resumes after Pi releases its compaction
lock; work explicitly paused by the user stays paused. Compaction failure leaves
the session available for intervention.

Pi aborts active work before its public manual-compaction hook, so a brief paused
update can precede that hook; successful manual compaction repairs the state and
continues the task. The bridge does not infer user intent solely from an aborted
provider response once the compaction hook is active.

The non-blocking completion notification and deferred auto-exit pattern follows
[pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents/tree/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7),
particularly its background watcher in `index.ts` and child-lifetime guard in
`subagent-done.ts`. Shared capacity, terminal control
channel and tool restrictions remain independent of the task format.

## Implementation references

`index.ts` registers Pi tools, commands and session hooks. `dispatcher.ts` owns
authorization, worker ownership, restoration and completion delivery. Its
headless wait retains parents through completion-triggered turns; the existing
20 ms idle check remains until Pi exposes a reliable notification covering both
worker completion and parent-turn settlement.

`core.ts` exposes `startWorker()`, which immediately returns a handle with `ready`,
`done`, `interrupt`, `resume`, `message` and `stop`. `ready` normally waits for the
worker's session-startup event. `done` settles only after process termination,
result persistence and resource cleanup; pause is a progress update and never
settles it. Setup or persistence failures reject the relevant promises. The
`runChild()` convenience function awaits the same final `done` promise.
`lifecycle.ts` defines permitted execution transitions; compaction remains a
separate concern in the worker-side `terminal.ts` bridge.

`core.ts` validates task text at the shared dispatcher boundary for tools, manual
commands and restored sessions. `worker-types.ts` distinguishes
definitions, saved loadouts, display previews and terminal results. `render.ts`
renders tool cards from `state.ts` snapshots; `activity.ts` provides bounded
previews, tree formatting and the live widget. `limits.ts`, `session-store.ts`
and `tmux.ts` retain their resource and persistence roles.

### Optional `ui-kit` integration

Transcript cards use lifecycle snapshots, not live progress. `WorkerStates`
ignores same-status running/paused progress; the separate live widget still
receives every update. Only that widget advances elapsed time from the clock.
Otherwise an offscreen historical card changes on progress or spinner repaint
and Pi clears/replays the entire scrollback. New workers and lifecycle transitions
(pause, resume, completion, failure, cancellation) still refresh cards; final
reports and restored-session reconciliation remain available.

Regression check with the installed Pi main-screen renderer:
`node --test render-redraw.test.mjs` (collapsed and expanded cards with descendants,
actual progress updates, a shared panel host, and 3000 lines of offscreen history).

When the `ui-kit` extension is active in a TUI session, subagents discovers it
through this in-process event contract; it does not import or depend on that
extension:

```text
ui-kit:v1:probe  { accept(host) }
ui-kit:v1:ready  host
ui-kit:v1:stopped host
host.upsert(panel), host.remove(id)
```

Subagents emits one synchronous `probe` request at TUI session start and accepts
the host through its callback. Only the host answers probes and emits `ready` or
`stopped`; subagents does not cache hosts across sessions or republish lifecycle
events.

The worker panel is one stable panel:
`{ id: "subagents:workers", order: 200, animated: <any running worker>, render(width, theme, {now, frame}) }`.
It uses the existing bounded `workerTree` renderer, including hierarchy,
activity, elapsed time, Unicode connectors and width-safe truncation. The host
owns the 120ms animation clock; state updates upsert the same panel immediately.
If no host is available, subagents registers one standalone widget once and uses
a local render-request timer. Settlement pruning and descendant retention are
unchanged. A stopped host is detached and the standalone fallback is restored.
Headless and non-TUI workers do not register UI components.

`worker.test.mjs` covers startup failure, shutdown during setup, fragmented event
channels, result-write failure and cleanup before completion. The tmux check
also exercises repeated pause/resume and shutdown of a paused worker; dispatcher
integration verifies repeated shutdown does not send a late completion message.

- Installed pi `examples/extensions/subagent/index.ts`: isolated JSON subprocess
  execution and independent per-worker streaming results. We use native parallel
  tool calls rather than copying its queued batch/chain API.
- Installed OM `src/ui/status-controller.ts` and `src/spawn/launch.ts`: parent-owned
  UI, one animation timer, settled-state cleanup and explicit child resources.
- [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents), inspected
  at `3325b4e012a7b92187783bcbc4b0b650b24fcba5`:
  `src/runs/shared/nested-events.ts`, `src/runs/background/owned-process-tree.ts`
  and `test/unit/widget-nested-render.test.ts` informed bounded parent-linked
  previews, tree tests and subtree cleanup. No new dependency was added.
- [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents): its nested
  concurrency deadlock explanation informed our **no-queue global cap**. We
  deliberately count nested workers, unlike that implementation's exemption.
## Execution mode and explicit handoff

`delegate({ agent, task, mode: "sync" | "async" })` lets the calling model choose:

- `async`: return startup acknowledgement; deliver one completion message later.
- `sync` (default): keep the tool call pending until the worker calls `finish_task` and exits
  with its results saved and resources released. Return the report and nested usage
  directly, without a duplicate completion turn. Startup errors, failures and
  cancellation also settle the call. Interrupt pauses do **not** settle it.

Every supervised worker, including leaves, receives the lifecycle tool
`finish_task({ report: "Findings, changes, evidence, and remaining limitations" })`.
Call it alone after owned children settle. It terminates the worker's agent loop;
the bridge forwards the report and requests normal shutdown at settlement.
Ordinary final prose without this call is a failed handoff, not successful completion.
At a normal assistant `message_end` without a handoff, the harness queues a hidden
follow-up reminder to call `finish_task` or continue unfinished work. It does not
remind on tool calls, errors, interrupted responses, or while owned children remain.
If the worker nevertheless exits without the tool, the handoff still fails.
Partial prose is retained for diagnostics. Reports are claims for parent review,
not independent verification or approval.

`delegate_message` remains asynchronous for steering and continuation. Existing
role tool lists need no edits: `finish_task` is injected by the harness, not an
additional work capability. Reload Pi before starting jobs with this protocol.
