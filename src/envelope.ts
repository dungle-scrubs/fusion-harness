import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { stdout } from "node:process";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_VALIDATION = 2;
export const EXIT_NOTHING_TAKEABLE = 3;
export const EXIT_INTERNAL = 4;

export type ExitClass = 0 | 1 | 2 | 3 | 4;

export const EXIT_HELP_TEXT = [
  "Exit codes: 0 ok, 1 usage (bad invocation), 2 validation/gate",
  "(input failed checks or a gate blocked), 3 nothing takeable (no",
  "usable result), 4 internal (bug; see E4xx).",
].join(" ");

export interface EnvelopeError {
  readonly code: string;
  readonly detail: string;
}

export interface Envelope {
  readonly ok: boolean;
  readonly run: string;
  readonly step: string;
  readonly errors: readonly EnvelopeError[];
}

export function formatError(error: EnvelopeError): string {
  return `${error.code}: ${error.detail}`;
}

function makeRunId(): string {
  return `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function newRunId(): string {
  return makeRunId();
}

export function envelopeOk(run: string): Envelope {
  return { errors: [], ok: true, run, step: "done" };
}

export function envelopeFail(
  run: string,
  step: string,
  errors: readonly { code: string; detail: string }[],
): Envelope {
  return { errors, ok: false, run, step };
}

export function printEnvelope(envelope: Envelope, json: boolean): void {
  if (json) {
    stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  for (const error of envelope.errors) {
    stdout.write(`${formatError(error)}\n`);
  }
}

/**
 * Durable command record: one start line before work, one end line after.
 * A start with no end is the trace of a hung or killed invocation.
 * Appends are diagnostics: a failed append never fails the command.
 */
export function commandRecordPath(repoRoot: string): string {
  return join(repoRoot, ".fusion", "commands.jsonl");
}

export function appendCommandRecord(path: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // diagnostics only
  }
}

export function startRecord(command: string, run: string): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    command,
    event: "start",
    pid: process.pid,
    run,
  };
}

export function endRecord(
  command: string,
  run: string,
  envelope: Envelope,
): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    command,
    errors: envelope.errors,
    event: "end",
    exit: envelope.ok ? EXIT_OK : exitCodeForErrors(envelope.errors),
    ok: envelope.ok,
    run,
  };
}

export function exitCodeForErrors(errors: readonly EnvelopeError[]): ExitClass {
  if (errors.length === 0) {
    return EXIT_OK;
  }
  const first = errors[0]?.code ?? "E499";
  const digit = Number(first[1]);
  if (Number.isInteger(digit) && digit >= 1 && digit <= 4) {
    return digit as ExitClass;
  }
  return EXIT_INTERNAL;
}

export interface CrashOptions {
  readonly command: string;
  readonly recordPath?: string;
  readonly runResolver: () => { run: string; step: string } | null;
}

export function tryWriteCrashEnvelope(envelope: Record<string, unknown>): boolean {
  try {
    writeSync(1, `${JSON.stringify(envelope)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Crash containment: any uncaught exception, rejection, or main-loop
 * failure routes here - one E499 envelope, one exit code (4), one record
 * path. Delivery is attempted through a synchronous stdout write; when a
 * run was resolved, its end record is appended as the durable trace.
 */
export function reportCrash(kind: string, error: unknown, options: CrashOptions): Envelope {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const resolved = options.runResolver();
  const envelope = envelopeFail(resolved?.run ?? "unknown", resolved?.step ?? "crash", [
    { code: "E499", detail: `${kind}: ${detail}` },
  ]);
  const crashed = { ...envelope, crashed: true } as Record<string, unknown>;
  tryWriteCrashEnvelope(crashed);
  if (options.recordPath !== undefined && resolved !== null) {
    appendCommandRecord(options.recordPath, {
      ...endRecord(options.command, resolved.run, envelope),
      crashed: true,
    });
  }
  process.exitCode = EXIT_INTERNAL;
  return envelope;
}

export function installCrashHandlers(options: CrashOptions): void {
  process.on("uncaughtException", (error) => reportCrash("uncaughtException", error, options));
  process.on("unhandledRejection", (reason) => reportCrash("unhandledRejection", reason, options));
}
