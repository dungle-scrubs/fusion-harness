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
import { type ClaimVerdict, validateClaim } from "./claim";
import { executeRun } from "./engine";
import {
  JURY_DEFAULT_WORKERS,
  JURY_MIN_WORKERS,
  type JuryDecision,
  juryFuse,
  juryWorkerPrompt,
} from "./jury";
import { claimantPrompt, redblueFuse, redblueWorkers } from "./redblue";
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

async function runJury(options: {
  harness: string;
  json: boolean;
  model?: string;
  task: string;
  timeout: string;
  workers: string;
}): Promise<void> {
  const workers = Number(options.workers);
  const timeout = Number(options.timeout);
  if (options.task.trim().length === 0) {
    stdout.write("error: --task must be non-empty\n");
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(workers) || workers < JURY_MIN_WORKERS) {
    stdout.write(`error: --workers must be an integer >= ${JURY_MIN_WORKERS}\n`);
    process.exitCode = 2;
    return;
  }
  if (!(timeout > 0)) {
    stdout.write("error: --timeout must be positive seconds\n");
    process.exitCode = 2;
    return;
  }
  const runId = `r${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const registration = {
    pattern: "jury",
    registeredAt: new Date().toISOString(),
    runId,
    stoppingRule: "every worker submits one answer claim or times out",
    task: options.task,
    workers: Array.from({ length: workers }, (_, index) => ({
      harness: options.harness,
      ...(options.model !== undefined ? { model: options.model } : {}),
      prompt: juryWorkerPrompt(options.task),
      timeoutSec: timeout,
      workerId: `w${index + 1}`,
    })),
  };
  const report = executeRun(registration, {
    fuse: juryFuse,
    repoRoot: process.cwd(),
  });
  const done = report.events[report.events.length - 1];
  const cause = done?.kind === "done" ? String(done.payload["cause"] ?? "failed") : "failed";
  const decisionPath = `${report.runDir}/decision.json`;
  if (options.json) {
    const decision = JSON.parse(readFileSync(decisionPath, "utf8")) as Record<string, unknown>;
    stdout.write(`${JSON.stringify(decision)}\n`);
  } else {
    const decision = JSON.parse(readFileSync(decisionPath, "utf8")) as JuryDecision["decision"] & {
      failures?: { class: string; workerId: string }[];
    };
    stdout.write(`run      ${runId} (${report.runDir})\n`);
    stdout.write(`decision ${decision.decision ?? "(none)"}\n`);
    const indep = decision.independence;
    stdout.write(
      `votes    ${indep.acceptedAnswers} answers, ${indep.groups} groups, duplicate rate ${indep.duplicateRate.toFixed(2)}\n`,
    );
    if ((decision.failures?.length ?? 0) > 0) {
      stdout.write(`failures ${JSON.stringify(decision.failures)}\n`);
    }
    for (const risk of decision.residualRisks) {
      stdout.write(`risk     ${risk.claimId} (conf ${risk.confidence}): ${risk.falsifier}\n`);
    }
  }
  process.exitCode = cause === "clean" ? 0 : 1;
}

program
  .command("jury")
  .description(
    "Sealed Jury pattern run: N sealed workers answer the task as claims; equivalent answers " +
      "are normalized; plurality fusion decides mechanically. Writes .fusion/runs/<runId>/. " +
      "Exits 0 clean, 1 run failure, 2 invalid invocation.",
  )
  .requiredOption("--task <t>", "the question every sealed juror answers")
  .option("--workers <n>", "number of sealed workers", String(JURY_DEFAULT_WORKERS))
  .option("--harness <h>", "harness for every worker (hcn name)", "pi")
  .option("--model <m>", "model id passed to every worker")
  .option("--timeout <sec>", "per-worker wall-clock budget in seconds", "180")
  .option("--json", "print the decision record as one JSON line")
  .action(
    async (options: {
      harness: string;
      json: boolean;
      model?: string;
      task: string;
      timeout: string;
      workers: string;
    }) => {
      await runJury(options);
    },
  );

async function runRedBlue(options: {
  burden: string;
  harness: string;
  json: boolean;
  model?: string;
  task: string;
  timeout: string;
}): Promise<void> {
  const timeout = Number(options.timeout);
  if (options.task.trim().length === 0 || options.burden.trim().length === 0) {
    stdout.write("error: --task and --burden must be non-empty\n");
    process.exitCode = 2;
    return;
  }
  if (!(timeout > 0)) {
    stdout.write("error: --timeout must be positive seconds\n");
    process.exitCode = 2;
    return;
  }
  const runId = `r${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const patternOptions = {
    burden: options.burden,
    harness: options.harness,
    ...(options.model !== undefined ? { model: options.model } : {}),
    task: options.task,
    timeoutSec: timeout,
  };
  const registration = {
    pattern: "red-blue",
    registeredAt: new Date().toISOString(),
    runId,
    rubric: options.burden,
    stoppingRule: "claimant files claims; opponent files objections; umpire rules; judge scores",
    task: options.task,
    workers: [
      {
        harness: options.harness,
        ...(options.model !== undefined ? { model: options.model } : {}),
        prompt: claimantPrompt(options.task),
        timeoutSec: timeout,
        workerId: "w-red",
      },
    ],
  };
  const report = executeRun(registration, {
    fuse: redblueFuse,
    repoRoot: process.cwd(),
    stages: {
      challenge: (input) => redblueWorkers(patternOptions, input, "challenge"),
      verify: (input) => redblueWorkers(patternOptions, input, "verify"),
    },
  });
  const done = report.events[report.events.length - 1];
  const cause = done?.kind === "done" ? String(done.payload["cause"] ?? "failed") : "failed";
  const decision = JSON.parse(readFileSync(`${report.runDir}/decision.json`, "utf8")) as Record<
    string,
    unknown
  >;
  if (options.json) {
    stdout.write(`${JSON.stringify(decision)}\n`);
  } else {
    stdout.write(`run      ${runId} (${report.runDir})\n`);
    stdout.write(`ruling   ${String(decision["decision"] ?? "(none)")}\n`);
    stdout.write(`verdict  ${String(decision["judgeVerdict"] ?? "(none)")}\n`);
    stdout.write(`claims   surviving ${JSON.stringify(decision["survivingClaims"])}\n`);
    for (const rejected of decision["rejectedClaims"] as { claimId: string; reason: string }[]) {
      stdout.write(`rejected ${rejected.claimId}: ${rejected.reason}\n`);
    }
  }
  process.exitCode = cause === "clean" ? 0 : 1;
}

program
  .command("red-blue")
  .description(
    "Red-Blue-Umpire pattern run: a claimant files atomic claims, an opponent " +
      "challenges with objection claims, an umpire resolves source facts (running " +
      "named executable checks), and a judge blind to worker identity scores the " +
      "surviving record against the burden. Writes .fusion/runs/<runId>/. " +
      "Exits 0 clean, 1 run failure, 2 invalid invocation.",
  )
  .requiredOption("--task <t>", "the question the claimant must answer with claims")
  .requiredOption("--burden <b>", "the standard the surviving record must meet")
  .option("--harness <h>", "harness for every role (hcn name)", "pi")
  .option("--model <m>", "model id passed to every role")
  .option("--timeout <sec>", "per-role wall-clock budget in seconds (symmetric)", "300")
  .option("--json", "print the decision record as one JSON line")
  .action(
    async (options: {
      burden: string;
      harness: string;
      json: boolean;
      model?: string;
      task: string;
      timeout: string;
    }) => {
      await runRedBlue(options);
    },
  );

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
