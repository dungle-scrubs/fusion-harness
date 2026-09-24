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
import { executeRun } from "./engine";
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
import { type PatternDefinition, type PatternOptions, toRegistration } from "./pattern";
import { redblueDefinition } from "./redblue";
import { shortlistDefinition } from "./shortlist";
import { SKILL_TEXT } from "./skill";
import { type AggregateMethod, aggregate, normalizeClaims, scoreForecasts } from "./tier1";

const VERSION = "0.2.1"; // x-release-please-version

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
      const registration = toRegistration(build, definition.command, {
        now: () => new Date().toISOString(),
        runId: patternRunId,
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
