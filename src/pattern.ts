import type { FuseFn, RunReport, StageBuilders } from "./engine";
import type { RunRegistration, WorkerConfig } from "./run";
import { type DrCitations, evidenceFromCitations, formatSuppliedEvidence } from "./tier1";

export interface OptionSpec {
  readonly default?: string;
  readonly description: string;
  readonly flag?: "boolean";
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
  readonly patternOptions?: Record<string, string | boolean>;
  readonly runId: string;
  readonly wait?: boolean;
  readonly waitUntil?: string;
}

export function toRegistration(
  build: PatternBuild,
  pattern: string,
  context: RegistrationContext,
): RunRegistration {
  return {
    pattern,
    ...(context.patternOptions !== undefined ? { patternOptions: context.patternOptions } : {}),
    registeredAt: context.now(),
    runId: context.runId,
    rubric: build.rubric,
    stoppingRule: build.stoppingRule,
    task: build.task,
    ...(context.wait === true ? { wait: true as const } : {}),
    ...(context.waitUntil !== undefined ? { waitUntil: context.waitUntil } : {}),
    workers: build.workers,
  };
}

export const WAIT_OPTION: OptionSpec = {
  description: "suspend at wave ends while a worker question stands; resume with fusion resume",
  flag: "boolean",
  name: "wait",
};

export const WAIT_SEC_OPTION: OptionSpec = {
  default: "3600",
  description: "hold deadline in seconds for a --wait suspension",
  name: "wait-sec",
};

export const EVIDENCE_OPTION: OptionSpec = {
  description:
    "dr citations export file (dr citations --json); researched sources workers must cite",
  name: "evidence",
};

/**
 * Resolve --evidence into a formatted prompt block. Reads the dr
 * citations export, converts mechanically, formats for prompts. Returns
 * an error string for unreadable or malformed input (E102 at build).
 */
export function resolveEvidence(
  options: PatternOptions,
  readFile: (path: string) => string,
): { error: string } | { block?: string } {
  const raw = options["evidence"];
  if (raw === undefined) {
    return {};
  }
  const path = String(raw);
  if (path.trim().length === 0) {
    return { error: "--evidence requires a file path" };
  }
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    return {
      error: `--evidence cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { error: `--evidence file ${path} is not valid JSON` };
  }
  const root =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const data =
    typeof root["data"] === "object" && root["data"] !== null
      ? (root["data"] as Record<string, unknown>)
      : {};
  const citations =
    typeof data["citations"] === "object" && data["citations"] !== null
      ? (data["citations"] as { documents?: unknown; unfetched?: unknown })
      : (root as { documents?: unknown; unfetched?: unknown });
  if (!Array.isArray(citations.documents)) {
    return { error: `--evidence file ${path} has no documents array` };
  }
  let block: string;
  try {
    block = formatSuppliedEvidence(evidenceFromCitations(citations as DrCitations));
  } catch (error) {
    return {
      error: `--evidence file ${path} is not a valid citations export: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { block };
}

/**
 * Resolve --wait/--wait-sec into registration fields. --wait-sec without
 * --wait is E102: a deadline with no suspension is a silent no-op.
 */
export function resolveWait(options: PatternOptions, now: () => string):
  | { error: string }
  | { wait?: boolean; waitUntil?: string } {
  const wait = options["wait"] === true || options["wait"] === "true";
  const rawSec = options["wait-sec"];
  if (!wait) {
    if (rawSec !== undefined) {
      return { error: "--wait-sec requires --wait" };
    }
    return {};
  }
  const seconds = rawSec === undefined ? 3600 : Number(rawSec);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { error: "--wait-sec must be positive seconds" };
  }
  return { wait: true, waitUntil: new Date(Date.parse(now()) + seconds * 1000).toISOString() };
}
