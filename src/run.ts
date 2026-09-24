/**
 * Run registry core (RFC-01, ticket #12): state machine, run registration,
 * and the streaming event contract. Pure module: no I/O, no spawning.
 */

export const SCHEMA_VERSION = "fusion/v0";
export const RUN_ID_PATTERN = /^r[0-9a-f]{8}$/;
export const WORKER_ID_PATTERN = /^w[a-z0-9-]+$/;

export const RUN_STAGES = [
  "REGISTERED",
  "SPAWNING",
  "GENERATING",
  "NORMALIZING",
  "CHALLENGING",
  "VERIFYING",
  "DECIDING",
  "DONE",
  "FAILED",
  "AWAITING-INPUT",
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

/**
 * Legal transitions the engine enforces. Stages run in order, once each.
 * AWAITING-INPUT suspends a --wait run at a wave end while a worker
 * question stands; fusion resume re-enters the suspended stage. FAILED is
 * reachable from any non-terminal stage; FAILED retains partial events.
 */
const TRANSITIONS: Record<Exclude<RunStage, "DONE" | "FAILED">, readonly RunStage[]> = {
  REGISTERED: ["SPAWNING"],
  SPAWNING: ["GENERATING"],
  GENERATING: ["NORMALIZING", "AWAITING-INPUT"],
  NORMALIZING: ["CHALLENGING", "DECIDING"],
  CHALLENGING: ["DECIDING", "VERIFYING", "AWAITING-INPUT"],
  VERIFYING: ["DECIDING", "AWAITING-INPUT"],
  DECIDING: ["DONE"],
  "AWAITING-INPUT": ["GENERATING", "CHALLENGING", "VERIFYING"],
};

export function nextStages(from: RunStage): readonly RunStage[] {
  if (from === "DONE" || from === "FAILED") {
    return [];
  }
  return TRANSITIONS[from];
}

export function isLegalTransition(from: RunStage, to: RunStage): boolean {
  if (from === to) {
    return false;
  }
  if (to === "FAILED") {
    return from !== "DONE";
  }
  return nextStages(from).includes(to);
}

export interface WorkerConfig {
  /** Worker id within the run, e.g. w1. */
  readonly workerId: string;
  /** Harness to spawn through `hcn run`. */
  readonly harness: string;
  /** Model id passed to hcn; undefined means the harness default. */
  readonly model?: string;
  /** Per-worker wall-clock budget, seconds. Maps to hcn --timeout. */
  readonly timeoutSec: number;
  readonly prompt: string;
}

export interface RunRegistration {
  readonly runId: string;
  readonly pattern: string;
  readonly task: string;
  readonly rubric?: string;
  readonly stoppingRule: string;
  readonly workers: readonly WorkerConfig[];
  readonly registeredAt: string;
  /** Opt-in caller wait: suspend at wave ends while a question stands. */
  readonly wait?: boolean;
  /** Hold deadline for a suspended run, ISO time. */
  readonly waitUntil?: string;
  /** Original pattern flags, for rebuild on resume. */
  readonly patternOptions?: Record<string, string | boolean>;
}

export interface PendingQuestion {
  readonly question: Record<string, unknown>;
  readonly sessionId: string;
  readonly workerId: string;
}

export interface SuspendedState {
  readonly pendingQuestions: readonly PendingQuestion[];
  readonly resumeStage: RunStage;
  readonly suspendedAt: string;
  readonly waitUntil?: string;
}

export type FusionEventKind =
  | "worker"
  | "claim"
  | "stage"
  | "fusion"
  | "decision"
  | "question"
  | "failure"
  | "done";

export interface FusionEvent {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly kind: FusionEventKind;
  readonly at: string;
  readonly payload: Record<string, unknown>;
}

export function makeEvent(
  runId: string,
  kind: FusionEventKind,
  payload: Record<string, unknown>,
  at: string = new Date().toISOString(),
): FusionEvent {
  return { at, kind, payload, runId, schemaVersion: SCHEMA_VERSION };
}

export interface StampedProvenance {
  readonly harness: string;
  readonly model: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly stampedAt: string;
  readonly workerId: string;
}

/**
 * Stamp provenance for a worker's claim. Every field comes from the
 * tool's own records (run registry + hcn identity event); nothing is
 * read from worker output, so workers cannot forge it.
 */
export function stampProvenance(args: {
  harness: string;
  model: string;
  runId: string;
  sessionId: string;
  workerId: string;
  stampedAt?: string;
}): StampedProvenance {
  return {
    harness: args.harness,
    model: args.model,
    runId: args.runId,
    sessionId: args.sessionId,
    stampedAt: args.stampedAt ?? new Date().toISOString(),
    workerId: args.workerId,
  };
}

/** Validate a registration before freezing run.json. Throws on violation. */
export function checkRegistration(reg: RunRegistration): void {
  if (!RUN_ID_PATTERN.test(reg.runId)) {
    throw new Error(`runId must match r[0-9a-f]{8}, got "${reg.runId}"`);
  }
  if (reg.task.trim().length === 0) {
    throw new Error("registration requires a non-empty task");
  }
  if (reg.stoppingRule.trim().length === 0) {
    throw new Error("registration requires a stopping rule");
  }
  if (reg.workers.length === 0) {
    throw new Error("registration requires at least one worker");
  }
  const seen = new Set<string>();
  for (const worker of reg.workers) {
    if (!WORKER_ID_PATTERN.test(worker.workerId)) {
      throw new Error(`workerId must match w[a-z0-9-]+, got "${worker.workerId}"`);
    }
    if (seen.has(worker.workerId)) {
      throw new Error(`duplicate workerId "${worker.workerId}"`);
    }
    seen.add(worker.workerId);
    if (worker.prompt.trim().length === 0) {
      throw new Error(`worker ${worker.workerId} requires a non-empty prompt`);
    }
    if (!(worker.timeoutSec > 0)) {
      throw new Error(`worker ${worker.workerId} requires a positive timeoutSec`);
    }
  }
}
