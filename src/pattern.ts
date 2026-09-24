import type { FuseFn, RunReport, StageBuilders } from "./engine";
import type { RunRegistration, WorkerConfig } from "./run";

export interface OptionSpec {
  readonly default?: string;
  readonly description: string;
  readonly name: string;
  readonly required?: boolean;
}

export interface PatternBuild {
  readonly fuse: FuseFn;
  readonly rubric?: string;
  readonly stages?: StageBuilders;
  readonly stoppingRule: string;
  readonly task: string;
  readonly workers: readonly WorkerConfig[];
}

export type PatternOptions = Record<string, string | boolean>;

export type BuildResult = { error: string } | PatternBuild;

export interface RosterEntry {
  readonly harness: string;
  readonly model?: string;
}

export const ROSTER_OPTION: OptionSpec = {
  description:
    "per-worker harness[:model], repeatable, position-mapped to worker index; " +
    "length must equal the worker count",
  name: "roster",
};

/**
 * Resolve per-worker harness/model assignments. Without --roster every
 * worker shares the --harness/--model pair (current behavior). With it,
 * each entry is one harness or harness:model; the count MUST equal the
 * worker count or the build fails before any spawn. Repeatable flags
 * arrive as a comma-joined string under commander, so split there too.
 */
export function resolveRoster(
  options: PatternOptions,
  workerCount: number,
): { error: string } | { roster: RosterEntry[] } {
  const fallback: RosterEntry = {
    harness: String(options["harness"] ?? "pi"),
    ...(options["model"] === undefined ? {} : { model: String(options["model"]) }),
  };
  const raw = options["roster"];
  if (raw === undefined) {
    return { roster: Array.from({ length: workerCount }, () => ({ ...fallback })) };
  }
  const entries = String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const separator = part.indexOf(":");
      if (separator === -1) {
        return { harness: part };
      }
      const harness = part.slice(0, separator).trim();
      const model = part.slice(separator + 1).trim();
      return {
        harness,
        ...(model.length === 0 ? {} : { model }),
      };
    })
    .filter((entry) => entry.harness.length > 0);
  if (entries.length !== workerCount) {
    return { error: `--roster expects ${workerCount} entries (one per worker), got ${entries.length}` };
  }
  return { roster: entries };
}

export interface DiversityCounts {
  readonly harnesses: number;
  readonly models: number;
}

/**
 * Mechanical diversity counts over accepted claims: distinct harnesses
 * and distinct models from tool-stamped provenance. A second
 * independence signal beside the duplicate rate, never proof of
 * independence on its own.
 */
export function diversityCounts(claims: readonly { provenance?: unknown }[]): DiversityCounts {
  const harnesses = new Set<string>();
  const models = new Set<string>();
  for (const item of claims) {
    const provenance = item.provenance;
    if (typeof provenance !== "object" || provenance === null) {
      continue;
    }
    const record = provenance as Record<string, unknown>;
    if (typeof record["harness"] === "string") {
      harnesses.add(record["harness"]);
    }
    if (typeof record["model"] === "string") {
      models.add(record["model"]);
    }
  }
  return { harnesses: harnesses.size, models: models.size };
}

export interface PatternDefinition {
  readonly command: string;
  readonly description: string;
  build(options: PatternOptions): BuildResult;
  readonly options: readonly OptionSpec[];
  summarize(decision: Record<string, unknown>, report: RunReport): readonly string[];
}

export interface RegistrationContext {
  readonly now: () => string;
  readonly runId: string;
}

export function toRegistration(
  build: PatternBuild,
  pattern: string,
  context: RegistrationContext,
): RunRegistration {
  return {
    pattern,
    registeredAt: context.now(),
    runId: context.runId,
    rubric: build.rubric,
    stoppingRule: build.stoppingRule,
    task: build.task,
    workers: build.workers,
  };
}
