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
