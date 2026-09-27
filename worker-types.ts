import type { DelegationContract } from "./contract.ts";

export interface WorkerObservation {
  state: "unseen" | "current" | "invalid";
  lastEventAt: number;
}

export type WorkerPhase = "starting" | "running" | "paused" | "stopping" | "ended";
export type WorkerStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export interface WorkerDefinition {
  name: string;
  description: string;
  model: string;
  thinking: string;
  callable: boolean;
  can_delegate: boolean;
  delegatable_agents: string[];
  tools: string[];
  systemPrompt: string;
}

export interface WorkerLimits {
  max_parallel: number;
  max_depth: number;
  max_children: number;
  max_nested_children: number;
}

export interface SavedLoadout {
  contract?: DelegationContract;
  version: number;
  agent: WorkerDefinition;
  task: string;
  cwd: string;
  toolExtensions: string[];
  limits: WorkerLimits;
  sessionFile: string;
}

export interface WorkerStarted {
  runDir: string;
  sessionFile: string;
}

export interface WorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface WorkerResult extends WorkerStarted {
  runId: string;
  parentRunId: string;
  status: Exclude<WorkerStatus, "running" | "paused">;
  output: string;
  error?: string;
  partialOutput: boolean;
  observation: WorkerObservation;
  usage: WorkerUsage;
  turns: number;
  elapsedMs: number;
}

export interface WorkerHandle {
  readonly phase: WorkerPhase;
  ready: Promise<WorkerStarted>;
  // Settles only after the process ends, its result is saved and resources close.
  done: Promise<WorkerResult>;
  interrupt(): void | Promise<unknown>;
  resume(message?: string): void | Promise<unknown>;
  message(text: string): void | Promise<unknown>;
  control(request: { runId: string; action: string; prompt?: string }): Promise<unknown>;
  stop(): void;
}

// Relayed display data is deliberately narrower than an execution result.
export interface WorkerPreview {
  runId: string;
  parentRunId: string;
  agent: string;
  role?: string;
  goal: string;
  model: string;
  thinking: string;
  status: WorkerStatus;
  observation?: WorkerObservation;
  activity: string;
  thinkingPreview: string;
  startedAt: number;
  elapsedMs: number;
  turns: number;
  usage: { cost: { total: number } };
}

export type WorkerProgress = Partial<WorkerPreview & WorkerStarted> & {
  output?: string;
  error?: string;
  recent?: string[];
};

export interface WorkerOptions {
  contract?: DelegationContract;
  agent: WorkerDefinition;
  task: string;
  cwd: string;
  runsDir: string;
  extensionPath: string;
  depth?: number;
  ticketsEnabled?: boolean;
  signal?: AbortSignal;
  command?: string;
  prefix?: string[];
  killGraceMs?: number;
  maxOutputBytes?: number;
  toolExtensions?: string[];
  limits?: WorkerLimits;
  pool?: string;
  runId?: string;
  parentRunId?: string;
  useTmux?: boolean;
  /** RPC is the production transport; JSON remains for legacy offline harnesses. */
  transport?: "rpc" | "json";
  resumeSession?: string;
  originalTask?: string;
  waitForSession?: boolean;
  onProgress?: (progress: WorkerProgress) => void;
  onDescendant?: (preview: unknown) => void;
  onPaneError?: (message: string) => void;
  onPrepared?: (started: WorkerStarted) => void | Promise<void>;
}
