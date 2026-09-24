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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateClaim } from "./claim";
import {
  checkRegistration,
  type FusionEvent,
  isLegalTransition,
  makeEvent,
  type PendingQuestion,
  RUN_ID_PATTERN,
  type RunRegistration,
  type RunStage,
  type StampedProvenance,
  stampProvenance,
  type SuspendedState,
  type WorkerConfig,
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
  resumeSessionId?: string;
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
  resumeSessionId?: string;
  timeoutSec: number;
}): WorkerResult {
  const args = ["run", config.harness, "--json", "--timeout", String(config.timeoutSec)];
  if (config.model !== undefined) {
    args.push("--model", config.model);
  }
  if (config.resumeSessionId !== undefined) {
    args.push("--resume", config.resumeSessionId, "--prompt", config.prompt);
  } else {
    args.push("--questions", "ask", config.prompt);
  }
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
  const seen = new Set<string>();
  const add = (parsed: unknown): void => {
    const key = JSON.stringify(parsed);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(parsed);
    }
  };
  const fenced = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const match of fenced) {
    const parsed = tryParse(match[1] ?? "");
    if (parsed !== undefined) {
      add(parsed);
    }
  }
  const remainder = text.replace(/```(?:json)?\s*[\s\S]*?```/g, "\n");
  for (const line of remainder.split("\n")) {
    const parsed = tryParse(line.trim());
    if (parsed !== undefined) {
      add(parsed);
    }
  }
  const direct = tryParse(remainder.trim());
  if (direct !== undefined) {
    add(direct);
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
  readonly stage: WorkerStage;
  readonly workerId: string;
}

export type WorkerStage = "challenge" | "generate" | "verify";

export type FuseFn = (accepted: readonly AcceptedClaim[]) => FusedOutput;

/**
 * Later-stage workers see prior claims without provenance (blind to
 * identity and model). `byWorker` groups the same claims per worker for
 * patterns whose later wave needs each worker's own prior output (Delphi
 * revision) while staying blind to the others' identities.
 */
export interface StageInput {
  readonly anonymizedClaims: readonly Record<string, unknown>[];
  readonly byWorker: ReadonlyMap<string, readonly Record<string, unknown>[]>;
}

export interface StageBuilders {
  readonly challenge?: (input: StageInput) => readonly WorkerConfig[];
  readonly verify?: (input: StageInput) => readonly WorkerConfig[];
}

export interface EngineOptions {
  readonly repoRoot: string;
  readonly spawn?: SpawnFn;
  readonly now?: () => string;
  /** Pattern stage: mechanical fusion of accepted claims (tier 1 only). */
  readonly fuse?: FuseFn;
  /** Sequential role stages after generation; prompts build from anonymized claims. */
  readonly stages?: StageBuilders;
}

export interface RunReport {
  readonly cause: "clean" | "failed" | "suspended";
  readonly decision: Record<string, unknown>;
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
function localIdsOf(raws: readonly unknown[]): Set<string> {
return new Set(
  raws
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => (typeof r["claim_id"] === "string" ? r["claim_id"] : null))
    .filter((id): id is string => id !== null),
);
}

/**
 * Run-scoped refs (`w1:C1`) are legal at the pattern boundary: later-stage
 * workers see prefixed ids in the anonymized record and echo them, both in
 * dependencies (correct - they target record claims) and sometimes as
 * their own claim_id (a copy of the record's id). The schema check runs
 * against bare ids; dependencies keep their prefixed form in storage
 * (they reference stamped claims), while a copied prefixed claim_id is
 * normalized to its local form so the worker prefix it receives is its
 * own.
 */
function bareIds(raw: unknown): unknown {
if (typeof raw !== "object" || raw === null) {
  return raw;
}
const claim = { ...(raw as Record<string, unknown>) };
if (typeof claim["claim_id"] === "string") {
  claim["claim_id"] = claim["claim_id"].replace(/^[a-z0-9-]+:/, "");
}
if (Array.isArray(claim["dependencies"])) {
  claim["dependencies"] = claim["dependencies"].map((dep: unknown) =>
    typeof dep === "string" ? dep.replace(/^[a-z0-9-]+:/, "") : dep,
  );
}
return claim;
}

function remapOne(
raw: unknown,
workerId: string,
localIds: ReadonlySet<string>,
): Record<string, unknown> {
const claim = { ...(raw as Record<string, unknown>) };
const localId =
  typeof claim["claim_id"] === "string" ? claim["claim_id"].replace(/^[a-z0-9-]+:/, "") : null;
if (localId !== null && localId !== "") {
  claim["claim_id"] = `${workerId}:${localId}`;
}
if (Array.isArray(claim["dependencies"])) {
  claim["dependencies"] = claim["dependencies"].map((dep: unknown) =>
    typeof dep === "string" && !dep.includes(":") && localIds.has(dep)
      ? `${workerId}:${dep}`
      : dep,
  );
}
return claim;
}

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
  const pending: PendingQuestion[] = [];
  let survivors = 0;

  /**
   * Suspend a --wait run at a wave end: persist pending questions with
   * the resume stage, enter AWAITING-INPUT, and return the suspended
   * report. The caller resumes with `fusion resume`; events.ndjson stays
   * append-only across the gap.
   */
  const suspend = (
    resumeStage: RunStage,
    finalizeSuspend: (report: RunReport) => RunReport,
  ): RunReport | null => {
    if (reg.wait !== true || pending.length === 0) {
      return null;
    }
    const suspendedAt = now();
    const suspended: SuspendedState = {
      pendingQuestions: [...pending],
      resumeStage,
      suspendedAt,
      ...(reg.waitUntil !== undefined ? { waitUntil: reg.waitUntil } : {}),
    };
    writeFileSync(
      join(runDir, "run.json"),
      `${JSON.stringify({ ...reg, suspended }, null, 2)}\n`,
    );
    enter("AWAITING-INPUT");
    emit(
      makeEvent(
        reg.runId,
        "done",
        { cause: "suspended", pending: pending.length, resumeStage },
        suspendedAt,
      ),
    );
    return finalizeSuspend({
      cause: "suspended",
      decision: {
        pendingQuestions: suspended.pendingQuestions,
        resumeStage,
        runId: reg.runId,
      },
      events,
      runDir,
      runId: reg.runId,
    });
  };


  const runWorkerTurn = (
    worker: WorkerConfig,
    claimStage: WorkerStage,
    prompt: string,
    attempt: number,
    acceptedLocalIds: Set<string>,
    resumeSessionId?: string,
  ): readonly { errors: readonly string[]; raw: unknown }[] => {
    const result = spawn({
      harness: worker.harness,
      model: worker.model,
      prompt,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      timeoutSec: worker.timeoutSec,
    });
    emit(
      makeEvent(
        reg.runId,
        "worker",
        {
          attempt,
          exitCode: result.exitCode,
          harness: worker.harness,
          model: worker.model ?? "harness-default",
          sessionId: result.identity?.sessionId ?? null,
          stage: claimStage,
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
      return [];
    }
    const localIds = localIdsOf(result.rawClaims);
    const rejected: { errors: readonly string[]; raw: unknown }[] = [];
    for (const raw of result.rawClaims) {
      const localId =
        typeof (raw as Record<string, unknown>)["claim_id"] === "string"
          ? String((raw as Record<string, unknown>)["claim_id"]).replace(/^[a-z0-9-]+:/, "")
          : null;
      if (localId !== null && acceptedLocalIds.has(localId)) {
        continue;
      }
      const verdict = validateClaim(bareIds(raw));
      if (!verdict.valid) {
        emit(
          makeEvent(
            reg.runId,
            "claim",
            {
              attempt,
              errors: verdict.errors,
              rejected: true,
              stage: claimStage,
              workerId: worker.workerId,
            },
            now(),
          ),
        );
        rejected.push({ errors: verdict.errors, raw });
        continue;
      }
      const stampedLocal = remapOne(raw, worker.workerId, localIds);
      const provenance: StampedProvenance = stampProvenance({
        harness: result.identity.harness,
        model: result.identity.requestedModel,
        runId: reg.runId,
        sessionId: result.identity.sessionId,
        stampedAt: now(),
        workerId: worker.workerId,
      });
      const stamped = { ...stampedLocal, provenance };
      emit(
        makeEvent(
          reg.runId,
          "claim",
          { attempt, claim: stamped, stage: claimStage, workerId: worker.workerId },
          now(),
        ),
      );
      accepted.push({ claim: stamped, stage: claimStage, workerId: worker.workerId });
      survivors += 1;
      if (localId !== null) {
        acceptedLocalIds.add(localId);
      }
    }
    if (result.question !== null) {
      emit(
        makeEvent(reg.runId, "question", {
          ...result.question,
          workerId: worker.workerId,
        }),
      );
      pending.push({
        question: result.question,
        sessionId: result.identity.sessionId,
        workerId: worker.workerId,
      });
    }
    return rejected;
  };

  const runWorkers = (workers: readonly WorkerConfig[], claimStage: WorkerStage): void => {
    for (const worker of workers) {
      const acceptedLocalIds = new Set<string>();
      const rejected = runWorkerTurn(worker, claimStage, worker.prompt, 1, acceptedLocalIds);
      if (rejected.length === 0) {
        continue;
      }
      const feedback = [
        "",
        "YOUR PREVIOUS SUBMISSION HAD CLAIMS REJECTED BY THE SCHEMA VALIDATOR:",
        ...rejected.flatMap((entry) => [
          "",
          `REJECTED CLAIM: ${JSON.stringify(entry.raw)}`,
          `ERRORS: ${entry.errors.join("; ")}`,
        ]),
        "",
        "Resubmit ONLY the rejected claims, corrected, one JSON object per line.",
        "Do not resubmit claims that were accepted; do not add new claims.",
      ].join("\n");
      runWorkerTurn(worker, claimStage, `${worker.prompt}\n${feedback}`, 2, acceptedLocalIds);
    }
  };

  const anonymized = (): readonly Record<string, unknown>[] =>
    accepted.map((entry) => {
      const { provenance: _provenance, ...rest } = entry.claim;
      return rest;
    });

  const byWorker = (): ReadonlyMap<string, readonly Record<string, unknown>[]> => {
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const entry of accepted) {
      const { provenance: _provenance, ...rest } = entry.claim;
      const existing = grouped.get(entry.workerId);
      if (existing === undefined) {
        grouped.set(entry.workerId, [rest]);
      } else {
        existing.push(rest);
      }
    }
    return grouped;
  };

  enter("GENERATING");
  runWorkers(reg.workers, "generate");
  const suspendedAfterGenerate = suspend("GENERATING", (report) => report);
  if (suspendedAfterGenerate !== null) {
    return suspendedAfterGenerate;
  }

  let cause: "clean" | "failed" | "suspended" = "failed";
  let decision: Record<string, unknown> = {};
  const finalize = (
    finalCause: "clean" | "failed" | "suspended",
    finalDecision: Record<string, unknown>,
  ): void => {
    cause = finalCause;
    decision = finalDecision;
    writeFileSync(join(runDir, "decision.json"), `${JSON.stringify(finalDecision, null, 2)}\n`);
    emit(makeEvent(reg.runId, "decision", finalDecision, now()));
    if (finalCause === "failed") {
      enter("FAILED");
    } else {
      enter("DONE");
    }
    emit(makeEvent(reg.runId, "done", { cause: finalCause, failures, survivors }, now()));
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
    return { cause, decision, events, runDir, runId: reg.runId };
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
  if (options.stages?.challenge !== undefined) {
    enter("CHALLENGING");
    runWorkers(
      options.stages.challenge({ anonymizedClaims: anonymized(), byWorker: byWorker() }),
      "challenge",
    );
    const suspendedAfterChallenge = suspend("CHALLENGING", (report) => report);
    if (suspendedAfterChallenge !== null) {
      return suspendedAfterChallenge;
    }
  }
  if (options.stages?.verify !== undefined) {
    enter("VERIFYING");
    runWorkers(
      options.stages.verify({ anonymizedClaims: anonymized(), byWorker: byWorker() }),
      "verify",
    );
    const suspendedAfterVerify = suspend("VERIFYING", (report) => report);
    if (suspendedAfterVerify !== null) {
      return suspendedAfterVerify;
    }
  }
  const fused = fuse(accepted);
  emit(makeEvent(reg.runId, "fusion", fused.fusion, now()));
  enter("DECIDING");
  finalize("clean", {
    ...fused.decision,
    cause: "clean",
    failures,
    survivors,
  });
  return { cause, decision, events, runDir, runId: reg.runId };
}

/**
 * Replay a run's event stream into accepted claims, failure records, and
 * survivor counts. Replays only the tool's own claim events carrying
 * stamped claims; every other event kind rebuilds nothing. The replayed
 * record is the tool's prior validated output, not new worker input, so
 * no schema check runs here. Returns the stage the stream last entered.
 */
export function replayEvents(events: readonly FusionEvent[]): {
  accepted: AcceptedClaim[];
  failures: { class: string; workerId: string }[];
  lastStage: RunStage | null;
  survivors: number;
} {
  const accepted: AcceptedClaim[] = [];
  const failures: { class: string; workerId: string }[] = [];
  const survivorsByWorker = new Set<string>();
  let lastStage: RunStage | null = null;
  for (const event of events) {
    if (event.kind === "stage" && typeof event.payload["stage"] === "string") {
      lastStage = event.payload["stage"] as RunStage;
    } else if (event.kind === "claim") {
      const payload = event.payload;
      if (payload["rejected"] === true) {
        continue;
      }
      const claim = payload["claim"];
      if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
        continue;
      }
      const record = claim as Record<string, unknown>;
      if (typeof record["provenance"] !== "object" || record["provenance"] === null) {
        continue;
      }
      const stage = payload["stage"];
      if (stage !== "generate" && stage !== "challenge" && stage !== "verify") {
        continue;
      }
      const workerId = payload["workerId"];
      if (typeof workerId !== "string") {
        continue;
      }
      accepted.push({ claim: record, stage, workerId });
      survivorsByWorker.add(workerId);
    } else if (event.kind === "failure") {
      const workerId = event.payload["workerId"];
      const failureClass = event.payload["class"];
      if (typeof workerId === "string" && typeof failureClass === "string") {
        failures.push({ class: failureClass, workerId });
      }
    }
  }
  return { accepted, failures, lastStage, survivors: survivorsByWorker.size };
}

/**
 * Find the wave a suspended run waited in: the last GENERATING,
 * CHALLENGING, or VERIFYING stage event before AWAITING-INPUT.
 */
function findSuspendResumeStage(stream: readonly FusionEvent[]): RunStage {
  let found: RunStage = "GENERATING";
  for (const event of stream) {
    if (event.kind === "stage" && typeof event.payload["stage"] === "string") {
      const stage = event.payload["stage"] as RunStage;
      if (stage === "GENERATING" || stage === "CHALLENGING" || stage === "VERIFYING") {
        found = stage;
      }
    }
  }
  return found;
}

/**
 * Continue a suspended run after its last pending question is answered:
 * replays events.ndjson to rebuild state, then executes the stages after
 * the suspended one with the caller's fuse and stage builders. The run
 * directory keeps appending; run.json suspension is already cleared by
 * resumeRun when remaining hit zero.
 */
export function continueRun(
  repoRoot: string,
  runId: string,
  options: EngineOptions & { fuse: FuseFn },
): { error: string } | { report: RunReport } {
  const runDir = join(repoRoot, ".fusion", "runs", runId);
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return { error: `unknown run "${runId}"` };
  }
  if (stored["suspended"] !== undefined) {
    return { error: `run "${runId}" still has pending questions` };
  }
  let stream: FusionEvent[];
  try {
    const text = readFileSync(join(runDir, "events.ndjson"), "utf8");
    stream = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FusionEvent);
  } catch {
    return { error: `run "${runId}" has no replayable event stream` };
  }
  const reg = stored as unknown as RunRegistration;
  try {
    checkRegistration(reg);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const spawn: SpawnFn = options.spawn ?? spawnHcnWorker;
  const now = options.now ?? (() => new Date().toISOString());
  const replayed = replayEvents(stream);
  const events: FusionEvent[] = [];
  const emit = (event: FusionEvent): void => {
    events.push(event);
    appendFileSync(join(runDir, "events.ndjson"), `${JSON.stringify(event)}\n`);
  };
  let stage: RunStage = findSuspendResumeStage(stream);
  const enter = (to: RunStage): void => {
    if (!isLegalTransition(stage, to)) {
      throw new Error(`illegal stage transition ${stage} -> ${to}`);
    }
    stage = to;
    emit(makeEvent(reg.runId, "stage", { stage: to }, now()));
  };
  const accepted: AcceptedClaim[] = [...replayed.accepted];
  const failures: { class: string; workerId: string }[] = [...replayed.failures];
  let survivors = replayed.survivors;
  const anonymized = (): readonly Record<string, unknown>[] =>
    accepted.map((entry) => {
      const { provenance: _provenance, ...rest } = entry.claim;
      return rest;
    });
  const byWorker = (): ReadonlyMap<string, readonly Record<string, unknown>[]> => {
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const entry of accepted) {
      const { provenance: _provenance, ...rest } = entry.claim;
      const existing = grouped.get(entry.workerId);
      if (existing === undefined) {
        grouped.set(entry.workerId, [rest]);
      } else {
        existing.push(rest);
      }
    }
    return grouped;
  };
  const runWorkers = (workers: readonly WorkerConfig[], claimStage: WorkerStage): void => {
    for (const worker of workers) {
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
            attempt: 1,
            exitCode: result.exitCode,
            harness: worker.harness,
            model: worker.model ?? "harness-default",
            sessionId: result.identity?.sessionId ?? null,
            stage: claimStage,
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
      for (const raw of result.rawClaims) {
        const verdict = validateClaim(bareIds(raw));
        if (!verdict.valid) {
          emit(
            makeEvent(
              reg.runId,
              "claim",
              { attempt: 1, errors: verdict.errors, rejected: true, stage: claimStage, workerId: worker.workerId },
              now(),
            ),
          );
          continue;
        }
        const stampedLocal = remapOne(raw, worker.workerId, localIdsOf(result.rawClaims));
        const provenance: StampedProvenance = stampProvenance({
          harness: result.identity.harness,
          model: result.identity.requestedModel,
          runId: reg.runId,
          sessionId: result.identity.sessionId,
          stampedAt: now(),
          workerId: worker.workerId,
        });
        const stamped = { ...stampedLocal, provenance };
        emit(
          makeEvent(
            reg.runId,
            "claim",
            { attempt: 1, claim: stamped, stage: claimStage, workerId: worker.workerId },
            now(),
          ),
        );
        accepted.push({ claim: stamped, stage: claimStage, workerId: worker.workerId });
        survivors += 1;
      }
    }
  };
  const fuse = options.fuse;
  const suspendedFrom =
    replayed.lastStage === "AWAITING-INPUT"
      ? findSuspendResumeStage(stream)
      : (replayed.lastStage ?? "NORMALIZING");
  const challengeDone = stream.some(
    (e) => e.kind === "stage" && e.payload["stage"] === "CHALLENGING",
  );
  const verifyDone = stream.some(
    (e) => e.kind === "stage" && e.payload["stage"] === "VERIFYING",
  );
  if (suspendedFrom === "GENERATING" || suspendedFrom === "NORMALIZING") {
    enter("NORMALIZING");
    stage = "NORMALIZING";
  } else {
    stage = suspendedFrom;
  }
  if (options.stages?.challenge !== undefined && !challengeDone) {
    enter("CHALLENGING");
    runWorkers(
      options.stages.challenge({ anonymizedClaims: anonymized(), byWorker: byWorker() }),
      "challenge",
    );
    stage = "CHALLENGING";
  }
  if (options.stages?.verify !== undefined && !verifyDone) {
    enter("VERIFYING");
    runWorkers(
      options.stages.verify({ anonymizedClaims: anonymized(), byWorker: byWorker() }),
      "verify",
    );
    stage = "VERIFYING";
  }
  const fused = fuse(accepted);
  emit(makeEvent(reg.runId, "fusion", fused.fusion, now()));
  enter("DECIDING");
  const decision = { ...fused.decision, cause: "clean", failures, survivors };
  writeFileSync(join(runDir, "decision.json"), `${JSON.stringify(decision, null, 2)}\n`);
  emit(makeEvent(reg.runId, "decision", decision, now()));
  enter("DONE");
  emit(makeEvent(reg.runId, "done", { cause: "clean", failures, survivors }, now()));
  return { report: { cause: "clean", decision, events, runDir, runId: reg.runId } };
}

/**
 * Resume a suspended --wait run: load run.json under repoRoot, answer one
 * pending question by resuming that worker's hcn session, mark it
 * answered, and rebuild the run context for the caller to continue from
 * the suspended stage. The answer comes from the caller side of the
 * trust boundary, so it is passed verbatim and never claim-validated.
 * Returns an error string for usage failures (unknown run, not suspended,
 * unknown worker, expired hold); the caller maps these to E102.
 */
export function resumeRun(
  repoRoot: string,
  runId: string,
  workerId: string,
  answer: string,
  options: Pick<EngineOptions, "spawn" | "now">,
): { error: string } | { resumed: ResumedRun } {
  if (!RUN_ID_PATTERN.test(runId)) {
    return { error: `unknown run "${runId}"` };
  }
  const runDir = join(repoRoot, ".fusion", "runs", runId);
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return { error: `unknown run "${runId}"` };
  }
  const suspended = stored["suspended"] as SuspendedState | undefined;
  if (suspended === undefined || !Array.isArray(suspended.pendingQuestions)) {
    return { error: `run "${runId}" is not suspended` };
  }
  const pending = suspended.pendingQuestions.find((p) => p.workerId === workerId);
  if (pending === undefined) {
    return { error: `run "${runId}" has no pending question for worker "${workerId}"` };
  }
  const now = options.now ?? (() => new Date().toISOString());
  if (suspended.waitUntil !== undefined && now() > suspended.waitUntil) {
    return { error: `run "${runId}" hold expired at ${suspended.waitUntil}` };
  }
  const workers = stored["workers"] as WorkerConfig[] | undefined;
  const worker = workers?.find((w) => w.workerId === workerId);
  if (worker === undefined) {
    return { error: `run "${runId}" has no worker "${workerId}"` };
  }
  const spawn: SpawnFn = options.spawn ?? spawnHcnWorker;
  appendFileSync(
    join(runDir, "events.ndjson"),
    `${JSON.stringify(makeEvent(runId, "question", { answer, resumed: true, workerId }, now()))}\n`,
  );
  const claimStage: WorkerStage =
    suspended.resumeStage === "CHALLENGING"
      ? "challenge"
      : suspended.resumeStage === "VERIFYING"
        ? "verify"
        : "generate";
  const resumed = spawn({
    harness: worker.harness,
    model: worker.model,
    prompt: answer,
    resumeSessionId: pending.sessionId,
    timeoutSec: worker.timeoutSec,
  });
  appendFileSync(
    join(runDir, "events.ndjson"),
    `${JSON.stringify(makeEvent(runId, "worker", { attempt: "resume", exitCode: resumed.exitCode, harness: worker.harness, sessionId: resumed.identity?.sessionId ?? null, stage: claimStage, workerId }, now()))}\n`,
  );
  if (resumed.exitCode !== 0 || resumed.identity === null) {
    appendFileSync(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(makeEvent(runId, "failure", { class: resumed.failureClass ?? "spawn-failed", exitCode: resumed.exitCode, workerId }, now()))}\n`,
    );
    return {
      error: `worker "${workerId}" resume failed (${resumed.failureClass ?? "spawn-failed"})`,
    };
  }
  const localIds = localIdsOf(resumed.rawClaims);
  let acceptedCount = 0;
  const stillPending: PendingQuestion[] =
    resumed.question === null
      ? []
      : [{ question: resumed.question, sessionId: resumed.identity.sessionId, workerId }];
  for (const raw of resumed.rawClaims) {
    const verdict = validateClaim(bareIds(raw));
    if (!verdict.valid) {
      appendFileSync(
        join(runDir, "events.ndjson"),
        `${JSON.stringify(makeEvent(runId, "claim", { attempt: "resume", errors: verdict.errors, rejected: true, stage: claimStage, workerId }, now()))}\n`,
      );
      continue;
    }
    const stampedLocal = remapOne(raw, workerId, localIds);
    const provenance: StampedProvenance = stampProvenance({
      harness: resumed.identity.harness,
      model: resumed.identity.requestedModel,
      runId,
      sessionId: resumed.identity.sessionId,
      stampedAt: now(),
      workerId,
    });
    appendFileSync(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(makeEvent(runId, "claim", { attempt: "resume", claim: { ...stampedLocal, provenance }, stage: claimStage, workerId }, now()))}\n`,
    );
    acceptedCount += 1;
  }
  if (resumed.question !== null) {
    appendFileSync(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(makeEvent(runId, "question", { ...resumed.question, workerId }, now()))}\n`,
    );
  }
  const remaining = [
    ...suspended.pendingQuestions.filter((p) => p.workerId !== workerId),
    ...stillPending,
  ];
  const next: RunRegistration & { suspended?: SuspendedState } = {
    ...(stored as unknown as RunRegistration),
    ...(remaining.length > 0
      ? {
          suspended: {
            pendingQuestions: remaining,
            resumeStage: suspended.resumeStage,
            suspendedAt: suspended.suspendedAt,
            ...(suspended.waitUntil !== undefined ? { waitUntil: suspended.waitUntil } : {}),
          },
        }
      : {}),
  };
  if (remaining.length === 0) {
    delete next.suspended;
  }
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(next, null, 2)}\n`);
  return {
    resumed: {
      acceptedClaims: acceptedCount,
      answeredWorker: worker,
      askedAgain: stillPending.length > 0,
      claimStage,
      pattern: String(stored["pattern"] ?? ""),
      remaining: remaining.length,
      resumeStage: suspended.resumeStage,
      runId,
    },
  };
}

export interface ResumedRun {
  readonly acceptedClaims: number;
  readonly answeredWorker: WorkerConfig;
  readonly askedAgain: boolean;
  readonly claimStage: WorkerStage;
  readonly pattern: string;
  readonly remaining: number;
  readonly resumeStage: RunStage;
  readonly runId: string;
}
