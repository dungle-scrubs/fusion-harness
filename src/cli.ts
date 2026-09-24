#!/usr/bin/env node
/**
 * fusion CLI entrypoint (RFC-01). Tier 1 subcommands are model-free,
 * deterministic, JSON in/out. Exit contract follows hcn: 0 clean,
 * 1 failure, 2 refusal (fusion rejected the invocation).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import { achDefinition } from "./ach";
import { type ClaimVerdict, validateClaim } from "./claim";
import { delphiDefinition } from "./delphi";
import { executeRun } from "./engine";
import { juryDefinition } from "./jury";
import { type PatternDefinition, type PatternOptions, toRegistration } from "./pattern";
import { redblueDefinition } from "./redblue";
import { SKILL_TEXT } from "./skill";
import { type AggregateMethod, aggregate, normalizeClaims, scoreForecasts } from "./tier1";

const VERSION = "0.1.0";

interface JsonVerdict {
  claim_id: string;
  errors: readonly string[];
  valid: boolean;
}

function toJson(line: string, index: number): JsonVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { claim_id: `line-${index + 1}`, errors: ["line is not valid JSON"], valid: false };
  }
  const verdict: ClaimVerdict = validateClaim(parsed);
  return { claim_id: verdict.claim_id, errors: verdict.errors, valid: verdict.valid };
}

function linesOf(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

function printHuman(verdict: JsonVerdict): void {
  if (verdict.valid) {
    stdout.write(`ok   ${verdict.claim_id}\n`);
  } else {
    stdout.write(`FAIL ${verdict.claim_id}: ${verdict.errors.join("; ")}\n`);
  }
}

function printMachine(verdict: JsonVerdict): void {
  stdout.write(`${JSON.stringify(verdict)}\n`);
}

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

async function runValidate(file: string | undefined, options: { json: boolean }): Promise<void> {
  let text: string;
  try {
    text = file === undefined ? await readStdin() : readFileSync(file, "utf8");
  } catch (error) {
    stdout.write(
      `error: cannot read input: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const lines = linesOf(text);
  if (lines.length === 0) {
    stdout.write("error: no claims on input\n");
    process.exitCode = 2;
    return;
  }
  let failures = 0;
  lines.forEach((line, index) => {
    const verdict = toJson(line, index);
    if (!verdict.valid) {
      failures += 1;
    }
    if (options.json) {
      printMachine(verdict);
    } else {
      printHuman(verdict);
    }
  });
  process.exitCode = failures === 0 ? 0 : 1;
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

const program = new Command();
program
  .exitOverride((error) => {
    if (
      error.code === "commander.help" ||
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.version"
    ) {
      return;
    }
    process.exit(2);
  })
  .name("fusion")
  .description("A composable fusion layer over agent harnesses.")
  .version(VERSION);

program
  .command("validate")
  .description(
    "Validate a JSONL stream of claims against the claim schema. Exits 0 when every claim is valid, 1 otherwise, 2 on unreadable input.",
  )
  .argument("[file]", "JSONL file of claims; reads stdin when omitted")
  .option("--json", "emit machine-readable verdict objects, one per line")
  .action(async (file: string | undefined, options: { json: boolean }) => {
    await runValidate(file, options);
  });

function readInput(file: string | undefined): Promise<string> {
  if (file !== undefined) {
    return Promise.resolve(readFileSync(file, "utf8"));
  }
  return readStdin();
}

function emitJson(value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

async function runJsonCommand<TInput>(
  file: string | undefined,
  parse: (text: string) => TInput,
  execute: (input: TInput) => unknown,
): Promise<void> {
  let text: string;
  try {
    text = await readInput(file);
  } catch (error) {
    stdout.write(
      `error: cannot read input: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }
  let input: TInput;
  try {
    input = parse(text);
  } catch (error) {
    stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    emitJson(execute(input));
  } catch (error) {
    stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

program
  .command("normalize")
  .description(
    "Group claims by exact match on canonicalized text (NFC, whitespace, casing, number formats). " +
      "Reads a JSON array of {claim_id, claim} objects from FILE or stdin; prints groups. " +
      "Exits 0 on success, 2 on unreadable or malformed input.",
  )
  .argument("[file]", "JSON file of claims; reads stdin when omitted")
  .action(async (file: string | undefined) => {
    await runJsonCommand(file, parseClaimArray, (claims) => ({
      groups: normalizeClaims(claims),
    }));
  });

program
  .command("aggregate")
  .description(
    "Fuse sealed votes mechanically: plurality, median, or confidence-weighted mean. " +
      "Reads a JSON object {method, votes: [{value, confidence}]} from FILE or stdin. " +
      "Exits 0 on success, 1 on unfusable input, 2 on unreadable or malformed input.",
  )
  .argument("[file]", "JSON file with method and votes; reads stdin when omitted")
  .action(async (file: string | undefined) => {
    await runJsonCommand(file, parseAggregateInput, ({ method, votes }) =>
      aggregate(method, votes),
    );
  });

program
  .command("score")
  .description(
    "Proper scoring rules (Brier, log) over resolved outcomes. " +
      "Reads a JSON array of {confidence, outcome} objects from FILE or stdin. " +
      "Exits 0 on success, 1 on unscorable input, 2 on unreadable or malformed input.",
  )
  .argument("[file]", "JSON file of resolved outcomes; reads stdin when omitted")
  .action(async (file: string | undefined) => {
    await runJsonCommand(file, parseOutcomeArray, (outcomes) => scoreForecasts(outcomes));
  });

const PATTERNS: readonly PatternDefinition[] = [
  juryDefinition,
  redblueDefinition,
  achDefinition,
  delphiDefinition,
];

for (const definition of PATTERNS) {
  const command = program
    .command(definition.command)
    .description(definition.description)
    .option("--json", "print the decision record as one JSON line");
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
    const build = definition.build(options);
    if ("error" in build) {
      stdout.write(`error: ${build.error}\n`);
      process.exitCode = 2;
      return;
    }
    const runId = `r${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const registration = toRegistration(build, definition.command, {
      now: () => new Date().toISOString(),
      runId,
    });
    const report = executeRun(registration, {
      ...(build.stages !== undefined ? { stages: build.stages } : {}),
      fuse: build.fuse,
      repoRoot: process.cwd(),
    });
    if (options["json"] === true) {
      stdout.write(`${JSON.stringify(report.decision)}\n`);
    } else {
      for (const line of definition.summarize(report.decision, report)) {
        stdout.write(`${line}\n`);
      }
    }
    process.exitCode = report.cause === "clean" ? 0 : 1;
  });
}

program
  .command("skill")
  .description("Print the complete caller-agent instructions to stdout.")
  .action(() => {
    stdout.write(SKILL_TEXT);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
