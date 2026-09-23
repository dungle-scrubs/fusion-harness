#!/usr/bin/env node
/**
 * fusion CLI entrypoint (RFC-01). Tier 1 subcommands are model-free,
 * deterministic, JSON in/out. Exit contract follows hcn: 0 clean,
 * 1 failure, 2 refusal (fusion rejected the invocation).
 */
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import { type ClaimVerdict, validateClaim } from "./claim";
import { SKILL_TEXT } from "./skill";

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

const program = new Command();
program
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
