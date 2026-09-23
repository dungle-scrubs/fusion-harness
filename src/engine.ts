/**
 * Tier 2 run engine (RFC-01, ticket #12). The tool owns the run end to end:
 * freezes run.json before generation, spawns sealed workers via `hcn run`
 * (separate processes, no shared transcript), validates worker output
 * against the claim schema at the tool boundary, stamps provenance from
 * the tool's own launch record bound to the harness-minted session id
 * from the hcn identity event, and appends every event to events.ndjson.
 * A worker that fails does not fail the run while survivors remain.
 *
 * Workers are untrusted content producers: the decision record contains
 * structured output, never worker transcripts.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateClaim } from "./claim";
import {
  checkRegistration,
  type FusionEvent,
  isLegalTransition,
  makeEvent,
  type RunRegistration,
  type RunStage,
  type StampedProvenance,
  stampProvenance,
} from "./run";

export interface HcnIdentity {
  readonly harness: string;
  /** Model the tool requested for this worker, not a confirmed value. */
  readonly requestedModel: string;
  /** Session id from the hcn identity event of this worker. */
  readonly sessionId: string;
}

export interface WorkerResult {
  /** hcn exit code: 0 clean (incl. a turn that ended by asking), 1 failure, 2 refusal. */
  readonly exitCode: number;
  readonly identity: HcnIdentity | null;
  readonly failureClass: string | null;
  /** Claims extracted from worker stdout message events. */
  readonly rawClaims: readonly unknown[];
  /** Question payload when the worker ended awaiting-input. */
  readonly question: Record<string, unknown> | null;
}

export type SpawnFn = (config: {
  harness: string;
  model?: string;
  prompt: string;
  timeoutSec: number;
}) => WorkerResult;

function parseHcnLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Default spawner: runs `hcn run` synchronously and parses its NDJSON. */
export function spawnHcnWorker(config: {
  harness: string;
  model?: string;
  prompt: string;
  timeoutSec: number;
}): WorkerResult {
  const args = ["run", config.harness, "--json", "--timeout", String(config.timeoutSec)];
  if (config.model !== undefined) {
    args.push("--model", config.model);
  }
  args.push("--questions", "ask", config.prompt);
  const proc = spawnSync("hcn", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const exitCode = proc.status ?? 1;
  let sessionId: string | null = null;
  let failureClass: string | null = null;
  let question: Record<string, unknown> | null = null;
  const rawClaims: unknown[] = [];
  for (const line of String(proc.stdout ?? "").split("\n")) {
    const event = parseHcnLine(line);
    if (event === null) {
      continue;
    }
    if (event["kind"] === "identity" && typeof event["sessionId"] === "string") {
      sessionId = event["sessionId"];
    } else if (event["kind"] === "failure") {
      failureClass = typeof event["class"] === "string" ? event["class"] : "unknown";
    } else if (event["kind"] === "question" && typeof event === "object") {
      question = event;
    } else if (event["kind"] === "message" && typeof event["text"] === "string") {
      for (const candidate of extractJsonObjects(event["text"])) {
        rawClaims.push(candidate);
      }
    } else if (event["kind"] === "done" && typeof event["failure"] === "object") {
      const failure = event["failure"] as Record<string, unknown>;
      if (typeof failure["class"] === "string") {
        failureClass = failure["class"];
      }
    }
  }
  const identity: HcnIdentity | null =
    sessionId === null
      ? null
      : {
          harness: config.harness,
          requestedModel: config.model ?? "harness-default",
          sessionId,
        };
  return { exitCode, failureClass, identity, question, rawClaims };
}

/**
 * Extract top-level JSON objects from a worker message. Workers emit
 * claims as fenced or bare JSON; anything else is ignored (never
 * forwarded raw into the decision record).
 */
export function extractJsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  const fenced = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const match of fenced) {
    const parsed = tryParse(match[1] ?? "");
    if (parsed !== undefined) {
      found.push(parsed);
    }
  }
  const remainder = text.replace(/```(?:json)?\s*[\s\S]*?```/g, " ");
  const direct = tryParse(remainder.trim());
  if (direct !== undefined) {
    found.push(direct);
  }
  return found;
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export interface FusedOutput {
  readonly fusion: Record<string, unknown>;
  readonly decision: Record<string, unknown>;
}

export interface AcceptedClaim {
  readonly claim: Record<string, unknown>;
  readonly workerId: string;
}

export type FuseFn = (accepted: readonly AcceptedClaim[]) => FusedOutput;

export interface EngineOptions {
  readonly repoRoot: string;
  readonly spawn?: SpawnFn;
  readonly now?: () => string;
  /** Pattern stage: mechanical fusion of accepted claims (tier 1 only). */
  readonly fuse?: FuseFn;
}

export interface RunReport {
  readonly events: readonly FusionEvent[];
  readonly runDir: string;
  readonly runId: string;
}

/**
 * Execute a sealed run: freeze registration in run.json, spawn workers,
 * validate claims at the boundary, stamp provenance, and finalize with
 * one path that always writes decision.json. A worker that fails does
 * not fail the run while survivors remain; a run with no survivors
 * enters FAILED, records the failure in run.json (registration
 * preserved), and still writes decision.json with cause "failed".
 */
export function executeRun(reg: RunRegistration, options: EngineOptions): RunReport {
  checkRegistration(reg);
  const spawn: SpawnFn = options.spawn ?? spawnHcnWorker;
  const now = options.now ?? (() => new Date().toISOString());
  const runDir = join(options.repoRoot, ".fusion", "runs", reg.runId);
  mkdirSync(runDir, { recursive: true });

  const events: FusionEvent[] = [];
  const emit = (event: FusionEvent): void => {
    events.push(event);
    appendFileSync(join(runDir, "events.ndjson"), `${JSON.stringify(event)}\n`);
  };

  let stage: RunStage = "REGISTERED";
  const enter = (to: RunStage): void => {
    if (!isLegalTransition(stage, to)) {
      throw new Error(`illegal stage transition ${stage} -> ${to}`);
    }
    stage = to;
    emit(makeEvent(reg.runId, "stage", { stage: to }, now()));
  };

  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(reg, null, 2)}\n`);
  enter("SPAWNING");

  const failures: { class: string; workerId: string }[] = [];
  const accepted: AcceptedClaim[] = [];
  let survivors = 0;
  enter("GENERATING");
  for (const worker of reg.workers) {
    const result = spawn({
      harness: worker.harness,
      model: worker.model,
      prompt: worker.prompt,
      timeoutSec: worker.timeoutSec,
    });
    emit(
      makeEvent(
        reg.runId,
        "worker",
        {
          exitCode: result.exitCode,
          harness: worker.harness,
          model: worker.model ?? "harness-default",
          sessionId: result.identity?.sessionId ?? null,
          workerId: worker.workerId,
        },
        now(),
      ),
    );
    if (result.exitCode !== 0 || result.identity === null) {
      emit(
        makeEvent(
          reg.runId,
          "failure",
          {
            class: result.failureClass ?? "spawn-failed",
            exitCode: result.exitCode,
            workerId: worker.workerId,
          },
          now(),
        ),
      );
      failures.push({ class: result.failureClass ?? "spawn-failed", workerId: worker.workerId });
      continue;
    }
    survivors += 1;
    for (const raw of result.rawClaims) {
      const verdict = validateClaim(raw);
      if (!verdict.valid) {
        emit(
          makeEvent(
            reg.runId,
            "claim",
            { errors: verdict.errors, rejected: true, workerId: worker.workerId },
            now(),
          ),
        );
        continue;
      }
      const provenance: StampedProvenance = stampProvenance({
        harness: result.identity.harness,
        model: result.identity.requestedModel,
        runId: reg.runId,
        sessionId: result.identity.sessionId,
        stampedAt: now(),
        workerId: worker.workerId,
      });
      emit(
        makeEvent(
          reg.runId,
          "claim",
          { claim: { ...(raw as Record<string, unknown>), provenance }, workerId: worker.workerId },
          now(),
        ),
      );
      accepted.push({
        claim: { ...(raw as Record<string, unknown>), provenance },
        workerId: worker.workerId,
      });
    }
    if (result.question !== null) {
      emit(
        makeEvent(reg.runId, "question", { ...result.question, workerId: worker.workerId }, now()),
      );
    }
  }

  const finalize = (cause: "clean" | "failed", decision: Record<string, unknown>): void => {
    writeFileSync(join(runDir, "decision.json"), `${JSON.stringify(decision, null, 2)}\n`);
    emit(makeEvent(reg.runId, "decision", decision, now()));
    if (cause === "failed") {
      enter("FAILED");
    } else {
      enter("DONE");
    }
    emit(makeEvent(reg.runId, "done", { cause, failures, survivors }, now()));
  };

  if (survivors === 0) {
    writeFileSync(
      join(runDir, "run.json"),
      `${JSON.stringify({ ...reg, failureRecord: { failures, survivors } }, null, 2)}\n`,
    );
    finalize("failed", {
      cause: "failed",
      failures,
      note: "no surviving workers; pattern stages never ran",
      runId: reg.runId,
      survivors,
    });
    return { events, runDir, runId: reg.runId };
  }

  const fuse: FuseFn =
    options.fuse ??
    (() => ({
      decision: {
        note: "decision stub: pattern stages (jury/red-blue/ach) fuse accepted claims in tickets #13-15",
      },
      fusion: {},
    }));

  enter("NORMALIZING");
  const fused = fuse(accepted);
  emit(makeEvent(reg.runId, "fusion", fused.fusion, now()));
  enter("DECIDING");
  finalize("clean", {
    ...fused.decision,
    cause: "clean",
    failures,
    survivors,
  });
  return { events, runDir, runId: reg.runId };
}
