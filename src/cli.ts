#!/usr/bin/env node
/**
 * fusion CLI entrypoint (RFC-01; envelope and exit contract per ADR-0002).
 * Every command emits an {ok, run, step, errors[]} envelope - machine
 * shaped with --json, human text plus error lines without - and exits by
 * class: 0 ok, 1 usage, 2 validation/gate, 3 nothing takeable, 4
 * internal. Each invocation appends start/end lines to
 * .fusion/commands.jsonl; a start with no end is a hung-or-killed trace.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import { achDefinition } from "./ach";
import { type ClaimVerdict, validateClaim } from "./claim";
import { delphiDefinition } from "./delphi";
import { continueRun, executeRun, resumeRun } from "./engine";
import {
  appendCommandRecord,
  commandRecordPath,
  type Envelope,
  type EnvelopeError,
  EXIT_HELP_TEXT,
  EXIT_OK,
  endRecord,
  envelopeFail,
  envelopeOk,
  exitCodeForErrors,
  installCrashHandlers,
  newRunId,
  printEnvelope,
  reportCrash,
  startRecord,
} from "./envelope";
import { gonogoDefinition } from "./gonogo";
import { juryDefinition } from "./jury";
import { type PatternDefinition, type PatternOptions, resolveWait, toRegistration } from "./pattern";
import { redblueDefinition } from "./redblue";
import { shortlistDefinition } from "./shortlist";
import { SKILL_TEXT } from "./skill";
import { type AggregateMethod, aggregate, type DrCitations, evidenceFromCitations, normalizeClaims, scoreForecasts } from "./tier1";

const VERSION = "0.2.3"; // x-release-please-version

interface ResolvedRun {
  run: string;
  step: string;
}

let resolved: ResolvedRun | null = null;
const COMMAND_RECORD = commandRecordPath(process.cwd());
const CRASH_OPTIONS = {
  command: process.argv[2] ?? "fusion",
  recordPath: COMMAND_RECORD,
  runResolver: () => resolved,
};
installCrashHandlers(CRASH_OPTIONS);

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data));
    stdin.on("error", (error: Error) => reject(error));
  });
}

async function readInput(file: string | undefined): Promise<string> {
  if (file !== undefined) {
    return readFileSync(file, "utf8");
  }
  return readStdin();
}

/**
 * One command's lifecycle: durable start line, work, envelope, durable
 * end line, exit code by error class. Never process.exit - the runtime
 * flushes stdout.
 */
async function runCommand(
  command: string,
  json: boolean,
  work: (run: string) => Promise<{ envelope: Envelope; payload?: Record<string, unknown> }>,
): Promise<void> {
  const run = newRunId();
  resolved = { run, step: command };
  appendCommandRecord(COMMAND_RECORD, startRecord(command, run));
  let envelope: Envelope;
  let payload: Record<string, unknown> | undefined;
  try {
    const outcome = await work(run);
    envelope = outcome.envelope;
    payload = outcome.payload;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    envelope = envelopeFail(run, command, [{ code: "E499", detail }]);
  }
  if (envelope.ok && payload !== undefined) {
    if (json) {
      stdout.write(`${JSON.stringify({ ...envelope, ...payload })}\n`);
    } else {
      const lines = payload["lines"] as readonly string[] | undefined;
      if (lines !== undefined) {
        for (const line of lines) {
          stdout.write(`${line}\n`);
        }
      }
    }
  } else {
    printEnvelope(envelope, json);
  }
  appendCommandRecord(COMMAND_RECORD, endRecord(command, run, envelope));
  process.exitCode = envelope.ok ? EXIT_OK : exitCodeForErrors(envelope.errors);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClaimArray(text: string): { claim: string; claim_id: string }[] {
  const parsed: unknown = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("normalize expects a JSON array of {claim_id, claim} objects");
  }
  return parsed.map((entry: unknown, index: number) => {
    if (
      !isRecord(entry) ||
      typeof entry["claim_id"] !== "string" ||
      typeof entry["claim"] !== "string"
    ) {
      throw new Error(`normalize entry ${index} must have string claim_id and claim`);
    }
    return { claim: entry["claim"], claim_id: entry["claim_id"] };
  });
}

const AGGREGATE_METHODS: readonly AggregateMethod[] = ["median", "plurality", "weighted"];

function parseAggregateInput(text: string): {
  method: AggregateMethod;
  votes: { confidence: number; value: string }[];
} {
  const parsed: unknown = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("aggregate expects a JSON object {method, votes}");
  }
  const method: unknown = parsed["method"];
  if (typeof method !== "string" || !AGGREGATE_METHODS.includes(method as AggregateMethod)) {
    throw new Error("aggregate method must be one of median|plurality|weighted");
  }
  const votes: unknown = parsed["votes"];
  if (!Array.isArray(votes)) {
    throw new Error("aggregate expects votes to be an array of {value, confidence}");
  }
  const typed = votes.map((entry: unknown, index: number) => {
    if (
      !isRecord(entry) ||
      typeof entry["value"] !== "string" ||
      typeof entry["confidence"] !== "number"
    ) {
      throw new Error(`aggregate vote ${index} must have string value and numeric confidence`);
    }
    return { confidence: entry["confidence"], value: entry["value"] };
  });
  return { method: method as AggregateMethod, votes: typed };
}

function parseOutcomeArray(text: string): { confidence: number; outcome: boolean }[] {
  const parsed: unknown = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("score expects a JSON array of {confidence, outcome} objects");
  }
  return parsed.map((entry: unknown, index: number) => {
    if (
      !isRecord(entry) ||
      typeof entry["confidence"] !== "number" ||
      typeof entry["outcome"] !== "boolean"
    ) {
      throw new Error(`score outcome ${index} must have numeric confidence and boolean outcome`);
    }
    return { confidence: entry["confidence"], outcome: entry["outcome"] };
  });
}

function emitParserError(error: unknown): void {
  const command = process.argv[2] ?? "fusion";
  const run = newRunId();
  resolved = { run, step: "argv" };
  appendCommandRecord(COMMAND_RECORD, startRecord(command, run));
  const envelope = envelopeFail(run, "argv", [
    {
      code: "E106",
      detail: error instanceof Error ? error.message : String(error),
    },
  ]);
  printEnvelope(envelope, false);
  appendCommandRecord(COMMAND_RECORD, endRecord(command, run, envelope));
  process.exitCode = 1;
}

const program = new Command();
program
  .name("fusion")
  .description("A composable fusion layer over agent harnesses.")
  .version(VERSION);

program
  .command("validate")
  .description("Validate a JSONL stream of claims against the claim schema. " + EXIT_HELP_TEXT)
  .argument("[file]", "JSONL file of claims; reads stdin when omitted")
  .option("--json", "emit the machine-shaped envelope with per-claim verdicts")
  .action(async (file: string | undefined, options: { json: boolean }) => {
    await runCommand("validate", options.json, async (run) => {
      let text: string;
      try {
        text = await readInput(file);
      } catch (error) {
        return {
          envelope: envelopeFail(run, "input", [
            {
              code: "E103",
              detail: `cannot read input: ${error instanceof Error ? error.message : String(error)}`,
            },
          ]),
        };
      }
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length === 0) {
        return {
          envelope: envelopeFail(run, "input", [{ code: "E302", detail: "no claims on input" }]),
        };
      }
      const errors: EnvelopeError[] = [];
      const verdicts: Record<string, unknown>[] = [];
      lines.forEach((line, index) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          errors.push({ code: "E104", detail: `line ${index + 1}: not valid JSON` });
          return;
        }
        const verdict: ClaimVerdict = validateClaim(parsed);
        if (!verdict.valid) {
          errors.push({
            code: "E201",
            detail: `claims: ${verdict.claim_id}: ${verdict.errors.join("; ")}`,
          });
        }
        verdicts.push({ claim_id: verdict.claim_id, errors: verdict.errors, valid: verdict.valid });
      });
      return {
        envelope: errors.length === 0 ? envelopeOk(run) : envelopeFail(run, "claims", errors),
        payload: { verdicts },
      };
    });
  });

async function runJsonTier1<TInput>(
  command: string,
  json: boolean,
  file: string | undefined,
  parse: (text: string) => TInput,
  execute: (input: TInput) => { result: Record<string, unknown>; lines: readonly string[] },
): Promise<void> {
  await runCommand(command, json, async (run) => {
    let text: string;
    try {
      text = await readInput(file);
    } catch (error) {
      return {
        envelope: envelopeFail(run, "input", [
          {
            code: "E103",
            detail: `cannot read input: ${error instanceof Error ? error.message : String(error)}`,
          },
        ]),
      };
    }
    let input: TInput;
    try {
      input = parse(text);
    } catch (error) {
      return {
        envelope: envelopeFail(run, "input", [
          {
            code: "E104",
            detail: error instanceof Error ? error.message : String(error),
          },
        ]),
      };
    }
    try {
      const { result, lines } = execute(input);
      return { envelope: envelopeOk(run), payload: { lines, result } };
    } catch (error) {
      return {
        envelope: envelopeFail(run, command, [
          {
            code: command === "aggregate" ? "E202" : "E203",
            detail: error instanceof Error ? error.message : String(error),
          },
        ]),
      };
    }
  });
}

program
  .command("normalize")
  .description(
    "Group claims by exact match on canonicalized text (NFC, whitespace, casing, number formats). " +
      EXIT_HELP_TEXT,
  )
  .argument("[file]", "JSON file of claims; reads stdin when omitted")
  .option("--json", "emit the machine-shaped envelope")
  .action(async (file: string | undefined, options: { json: boolean }) => {
    await runJsonTier1("normalize", options.json, file, parseClaimArray, (claims) => {
      const groups = normalizeClaims(claims);
      return {
        lines: groups.map((g) => `${g.members.join(", ")} -> ${g.canonical}`),
        result: { groups },
      };
    });
  });

program
  .command("aggregate")
  .description(
    "Fuse sealed votes mechanically: plurality, median, or confidence-weighted mean. " +
      EXIT_HELP_TEXT,
  )
  .argument("[file]", "JSON file with method and votes; reads stdin when omitted")
  .option("--json", "emit the machine-shaped envelope")
  .action(async (file: string | undefined, options: { json: boolean }) => {
    await runJsonTier1("aggregate", options.json, file, parseAggregateInput, (input) => {
      const result = aggregate(input.method, input.votes) as unknown as Record<string, unknown>;
      return { lines: [JSON.stringify(result)], result };
    });
  });

function parseCitationsExport(text: string): DrCitations {
  const parsed: unknown = JSON.parse(text) as unknown;
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
      ? (data["citations"] as Record<string, unknown>)
      : root;
  return {
    ...(Array.isArray(citations["documents"]) ? { documents: citations["documents"] } : {}),
    ...(Array.isArray(citations["unfetched"]) ? { unfetched: citations["unfetched"] } : {}),
  };
}

program
  .command("score")
  .description("Proper scoring rules (Brier, log) over resolved outcomes. " + EXIT_HELP_TEXT)
  .argument("[file]", "JSON file of resolved outcomes; reads stdin when omitted")
  .option("--json", "emit the machine-shaped envelope")
  .action(async (file: string | undefined, options: { json: boolean }) => {
    await runJsonTier1("score", options.json, file, parseOutcomeArray, (outcomes) => {
      const result = scoreForecasts(outcomes) as unknown as Record<string, unknown>;
      return { lines: [JSON.stringify(result)], result };
    });
  });

program
  .command("evidence")
  .description(
    "Convert a dr citations export into per-claim evidence blocks for claim evidence[] fields. " +
      EXIT_HELP_TEXT,
  )
  .argument("[file]", "dr citations JSON (dr citations --json); reads stdin when omitted")
  .option("--json", "emit the machine-shaped envelope")
  .action(async (file: string | undefined, options: { json: boolean }) => {
    await runJsonTier1("evidence", options.json, file, parseCitationsExport, (input) => {
      const supplied = evidenceFromCitations(input) as unknown as Record<string, unknown>[];
      const lines = supplied.map((s) => {
        const record = s as {
          claimId: string;
          evidence: { source_or_test: string }[];
          excluded: { reason: string }[];
        };
        return `${record.claimId}: ${record.evidence.length} sources, ${record.excluded.length} excluded`;
      });
      return { lines, result: { supplied } };
    });
  });

const PATTERNS: readonly PatternDefinition[] = [
  juryDefinition,
  redblueDefinition,
  achDefinition,
  delphiDefinition,
  shortlistDefinition,
  gonogoDefinition,
];

for (const definition of PATTERNS) {
  const command = program
    .command(definition.command)
    .description(`${definition.description} ${EXIT_HELP_TEXT}`)
    .option("--json", "emit the machine-shaped envelope with the decision record")
    .exitOverride((error) => {
      if (
        error.code === "commander.help" ||
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return;
      }
      emitParserError(error);
    })
    .configureOutput({ writeErr: () => {}, writeOut: (str) => stdout.write(str) });
  for (const spec of definition.options) {
    if (spec.flag === "boolean") {
      command.option(`--${spec.name}`, spec.description);
      continue;
    }
    const flag = `--${spec.name} <${spec.name}>`;
    if (spec.required === true) {
      command.requiredOption(flag, spec.description);
    } else if (spec.default !== undefined) {
      command.option(flag, spec.description, spec.default);
    } else {
      command.option(flag, spec.description);
    }
  }
  command.action(async (options: PatternOptions) => {
    await runCommand(definition.command, options["json"] === true, async (run) => {
      const build = definition.build(options);
      if ("error" in build) {
        return {
          envelope: envelopeFail(run, "build", [{ code: "E102", detail: build.error }]),
        };
      }
      resolved = { run, step: "executeRun" };
      const patternRunId = `r${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const waited = resolveWait(options, () => new Date().toISOString());
      if ("error" in waited) {
        return {
          envelope: envelopeFail(run, "build", [{ code: "E102", detail: waited.error }]),
        };
      }
      const registration = toRegistration(build, definition.command, {
        now: () => new Date().toISOString(),
        patternOptions: { ...options },
        runId: patternRunId,
        ...(waited.wait === true ? { wait: true as const } : {}),
        ...(waited.waitUntil !== undefined ? { waitUntil: waited.waitUntil } : {}),
      });
      const report = executeRun(registration, {
        ...(build.stages !== undefined ? { stages: build.stages } : {}),
        fuse: build.fuse,
        repoRoot: process.cwd(),
      });
      const payload = {
        decision: report.decision,
        lines: definition.summarize(report.decision, report),
        runDir: report.runDir,
      };
      if (report.cause === "suspended") {
        const pending = (report.decision["pendingQuestions"] ?? []) as { workerId: string }[];
        return {
          envelope: envelopeFail(run, "executeRun", [
            {
              code: "E303",
              detail: `pattern run ${patternRunId} suspended with ${pending.length} pending questions; resume with fusion resume --run ${patternRunId} --worker <id> --answer <text>; record at ${report.runDir}`,
            },
          ]),
          payload,
        };
      }
      if (report.cause !== "clean") {
        return {
          envelope: envelopeFail(run, "executeRun", [
            {
              code: "E301",
              detail: `pattern run ${patternRunId} failed with no surviving workers; record at ${report.runDir}`,
            },
          ]),
          payload,
        };
      }
      return { envelope: envelopeOk(run), payload };
    });
  });
}

program
  .command("resume")
  .description(
    "Answer one pending worker question and continue a suspended --wait run. " + EXIT_HELP_TEXT,
  )
  .requiredOption("--run <runId>", "suspended run id (r........)")
  .requiredOption("--worker <workerId>", "worker with the pending question")
  .requiredOption("--answer <text>", "answer passed verbatim to the worker hcn session")
  .option("--abort", "fail the suspended run explicitly instead of answering")
  .option("--json", "emit the machine-shaped envelope with the decision record")
  .action(
    async (options: {
      run: string;
      worker: string;
      answer?: string;
      abort?: boolean;
      json?: boolean;
    }) => {
      await runCommand("resume", options.json === true, async (run) => {
        const repoRoot = process.cwd();
        const runDir = `${repoRoot}/.fusion/runs/${options.run}`;
        if (options.abort === true) {
          const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          let stored: Record<string, unknown>;
          try {
            stored = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as Record<
              string,
              unknown
            >;
          } catch {
            return {
              envelope: envelopeFail(run, "resume", [
                { code: "E102", detail: `unknown run "${options.run}"` },
              ]),
            };
          }
          if (stored["suspended"] === undefined) {
            return {
              envelope: envelopeFail(run, "resume", [
                { code: "E102", detail: `run "${options.run}" is not suspended` },
              ]),
            };
          }
          const at = new Date().toISOString();
          appendFileSync(
            join(runDir, "events.ndjson"),
            `${JSON.stringify({ at, kind: "stage", payload: { stage: "FAILED" }, runId: options.run, schemaVersion: "fusion/v0" })}\n`,
          );
          appendFileSync(
            join(runDir, "events.ndjson"),
            `${JSON.stringify({ at, kind: "done", payload: { cause: "aborted" }, runId: options.run, schemaVersion: "fusion/v0" })}\n`,
          );
          writeFileSync(
            join(runDir, "decision.json"),
            `${JSON.stringify({ cause: "aborted", runId: options.run }, null, 2)}\n`,
          );
          const payload = {
            decision: { cause: "aborted", runId: options.run },
            lines: [`aborted  ${options.run} (${runDir})`],
            runDir,
          };
          return { envelope: envelopeOk(run), payload };
        }
        if (options.answer === undefined) {
          return {
            envelope: envelopeFail(run, "resume", [
              { code: "E102", detail: "--answer is required unless --abort is set" },
            ]),
          };
        }
        if (!/^r[0-9a-f]{8}$/.test(options.run) || /\.\.|\//.test(options.run)) {
          return {
            envelope: envelopeFail(run, "resume", [
              { code: "E102", detail: `unknown run "${options.run}"` },
            ]),
          };
        }
        if (!/^w[a-z0-9-]+$/.test(options.worker)) {
          return {
            envelope: envelopeFail(run, "resume", [
              { code: "E102", detail: `unknown worker "${options.worker}"` },
            ]),
          };
        }
        resolved = { run, step: "resumeRun" };
        const answered = resumeRun(repoRoot, options.run, options.worker, options.answer, {});
        if ("error" in answered) {
          return {
            envelope: envelopeFail(run, "resumeRun", [
              { code: "E102", detail: answered.error },
            ]),
          };
        }
        const { resumed } = answered;
        if (resumed.remaining > 0 || resumed.askedAgain) {
          const lines = [
            `run      ${resumed.runId} (${repoRoot}/.fusion/runs/${resumed.runId})`,
            `answered ${resumed.answeredWorker.workerId} (${resumed.acceptedClaims} claims accepted)`,
            resumed.remaining > 0
              ? `pending  ${resumed.remaining} questions still open`
              : `pending  worker asked again; answer with fusion resume`,
          ];
          return {
            envelope: envelopeFail(run, "resumeRun", [
              {
                code: "E303",
                detail: `run ${resumed.runId} still suspended; ${resumed.remaining} pending questions`,
              },
            ]),
            payload: { decision: { ...resumed }, lines, runDir },
          };
        }
        resolved = { run, step: "continueRun" };
        const definition = PATTERNS.find((d) => d.command === resumed.pattern);
        if (definition === undefined) {
          return {
            envelope: envelopeFail(run, "continueRun", [
              { code: "E499", detail: `unknown pattern "${resumed.pattern}" in run record` },
            ]),
          };
        }
        const stored = JSON.parse(
          readFileSync(`${repoRoot}/.fusion/runs/${options.run}/run.json`, "utf8"),
        ) as {
          patternOptions?: Record<string, string | boolean>;
        };
        const rebuilt = definition.build({
          ...(stored.patternOptions ?? {}),
          json: false,
        });
        if ("error" in rebuilt) {
          return {
            envelope: envelopeFail(run, "continueRun", [
              { code: "E499", detail: `cannot rebuild pattern "${resumed.pattern}": ${rebuilt.error}` },
            ]),
          };
        }
        const continued = continueRun(repoRoot, options.run, {
          ...(rebuilt.stages !== undefined ? { stages: rebuilt.stages } : {}),
          fuse: rebuilt.fuse,
          repoRoot,
        });
        if ("error" in continued) {
          return {
            envelope: envelopeFail(run, "continueRun", [
              { code: "E499", detail: continued.error },
            ]),
          };
        }
        return {
          envelope: envelopeOk(run),
          payload: {
            decision: continued.report.decision,
            lines: definition.summarize(continued.report.decision, continued.report),
            runDir: continued.report.runDir,
          },
        };
      });
    },
  );

program
  .command("skill")
  .description("Print the complete caller-agent instructions to stdout.")
  .action(() => {
    stdout.write(SKILL_TEXT);
  });

program
  .exitOverride((error) => {
    if (
      error.code === "commander.help" ||
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.version"
    ) {
      return;
    }
    emitParserError(error);
  })
  .configureOutput({ writeErr: () => {}, writeOut: (str) => stdout.write(str) });

program.parseAsync(process.argv).catch((error: unknown) => {
  reportCrash("parseAsync", error, CRASH_OPTIONS);
});
