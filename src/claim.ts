/**
 * fusion claim schema as code (RFC-01, ticket #10).
 *
 * One flat schema for all patterns. Pattern-specific strictness is enforced
 * at the pattern run's stage, not here: jury requires kind=answer, ACH
 * requires dependencies, red-blue requires kind=objection.
 *
 * Pure module: no I/O, no model calls, deterministic.
 */

export const CLAIM_ID_PATTERN = /^C[0-9]+$/;

export const CLAIM_KINDS = ["answer", "evidence", "finding", "hypothesis", "objection"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_STATUSES = ["documented", "inferred", "observed", "unknown"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CONFIDENCE_MAX = 1;
export const CONFIDENCE_MIN = 0;

export const EVIDENCE_REQUIRED_FIELDS = ["source_or_test", "supports"] as const;

export const NOVELTIES = ["confirms", "contradicts", "duplicates", "new"] as const;
export type Novelty = (typeof NOVELTIES)[number];

export const REQUESTED_ACTIONS = ["abstain", "accept", "escalate", "revise", "test"] as const;
export type RequestedAction = (typeof REQUESTED_ACTIONS)[number];

/** Fields an agent may set. `provenance` is tool-stamped and absent here. */
export const AGENT_SETTABLE_FIELDS = [
  "assumptions",
  "claim",
  "claim_id",
  "confidence",
  "dependencies",
  "evidence",
  "falsifier",
  "kind",
  "novelty",
  "requested_action",
  "status",
] as const;
export type AgentSettableField = (typeof AGENT_SETTABLE_FIELDS)[number];

export const REQUIRED_FIELDS = [
  "claim",
  "claim_id",
  "confidence",
  "falsifier",
  "kind",
  "status",
] as const;

export interface ClaimEvidence {
  readonly source_or_test: string;
  readonly supports: string;
  readonly url?: string;
}

export interface Claim {
  readonly assumptions?: readonly string[];
  readonly claim: string;
  readonly claim_id: string;
  readonly confidence: number;
  readonly dependencies?: readonly string[];
  readonly evidence?: readonly ClaimEvidence[];
  readonly falsifier: string;
  readonly kind: ClaimKind;
  readonly novelty?: Novelty;
  readonly requested_action?: RequestedAction;
  readonly status: ClaimStatus;
}

export interface ClaimVerdict {
  readonly claim_id: string;
  readonly errors: readonly string[];
  readonly valid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkEnum<TValue extends string>(
  readonlyValues: readonly TValue[],
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (typeof value !== "string" || !readonlyValues.includes(value as TValue)) {
    errors.push(`${field} must be one of ${[...readonlyValues].join("|")}`);
  }
}

/**
 * Validate one claim object. Returns a verdict; never throws on
 * malformed input. Unknown fields are rejected, not ignored. Any
 * agent-set `provenance` field is rejected: provenance is the only
 * tool-stamped block.
 */
export function validateClaim(input: unknown): ClaimVerdict {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { claim_id: "unknown", errors: ["claim must be a JSON object"], valid: false };
  }
  const claimId = typeof input.claim_id === "string" ? input.claim_id : "unknown";

  const agentSettable = new Set<string>(AGENT_SETTABLE_FIELDS);
  for (const key of Object.keys(input)) {
    if (key === "provenance") {
      errors.push("provenance is tool-stamped: an agent cannot set it");
    } else if (!agentSettable.has(key)) {
      errors.push(`unknown field "${key}"`);
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in input)) {
      errors.push(`missing required "${field}"`);
    }
  }

  if (typeof input["claim_id"] !== "string" || !CLAIM_ID_PATTERN.test(input["claim_id"])) {
    errors.push("claim_id must match C[0-9]+");
  }
  checkEnum(CLAIM_KINDS, input["kind"], "kind", errors);
  checkEnum(CLAIM_STATUSES, input["status"], "status", errors);

  const confidence = input["confidence"];
  if (
    typeof confidence !== "number" ||
    Number.isNaN(confidence) ||
    confidence < CONFIDENCE_MIN ||
    confidence > CONFIDENCE_MAX
  ) {
    errors.push("confidence must be a number in [0,1]");
  }

  if (typeof input["claim"] !== "string" || input["claim"].trim().length === 0) {
    errors.push("claim must be a non-empty string");
  }
  if (typeof input["falsifier"] !== "string" || input["falsifier"].trim().length === 0) {
    errors.push("falsifier must be a non-empty string");
  }

  const evidence = input["evidence"];
  if (evidence !== undefined) {
    if (!Array.isArray(evidence)) {
      errors.push("evidence must be an array");
    } else {
      evidence.forEach((entry: unknown, index: number) => {
        if (!isRecord(entry)) {
          errors.push(`evidence[${index}] must be an object`);
          return;
        }
        for (const key of Object.keys(entry)) {
          if (key !== "source_or_test" && key !== "supports" && key !== "url") {
            errors.push(`evidence[${index}] has unknown field "${key}"`);
          }
        }
        for (const field of EVIDENCE_REQUIRED_FIELDS) {
          if (typeof entry[field] !== "string" || (entry[field] as string).trim().length === 0) {
            errors.push(`evidence[${index}] requires non-empty "${field}"`);
          }
        }
        if (entry["url"] !== undefined && typeof entry["url"] !== "string") {
          errors.push(`evidence[${index}].url must be a string`);
        }
      });
    }
  }

  const assumptions = input["assumptions"];
  if (assumptions !== undefined) {
    if (!Array.isArray(assumptions) || assumptions.some((a: unknown) => typeof a !== "string")) {
      errors.push("assumptions must be an array of strings");
    }
  }

  const dependencies = input["dependencies"];
  if (dependencies !== undefined) {
    if (
      !Array.isArray(dependencies) ||
      dependencies.some((d: unknown) => typeof d !== "string" || !CLAIM_ID_PATTERN.test(d))
    ) {
      errors.push("dependencies must be C[0-9]+ refs");
    }
  }

  if (input["novelty"] !== undefined) {
    checkEnum(NOVELTIES, input["novelty"], "novelty", errors);
  }
  if (input["requested_action"] !== undefined) {
    checkEnum(REQUESTED_ACTIONS, input["requested_action"], "requested_action", errors);
  }

  return { claim_id: claimId, errors, valid: errors.length === 0 };
}

/** Validate a list of claims, one verdict per claim, in input order. */
export function validateClaims(inputs: readonly unknown[]): ClaimVerdict[] {
  return inputs.map(validateClaim);
}
