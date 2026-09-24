import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CANONICAL = new URL("../skill/SKILL.md", import.meta.url).pathname;

describe("accompanying skill shape (standards-cli policy)", () => {
  const text = readFileSync(CANONICAL, "utf8");

  it("frontmatter description is the awareness surface in scenario terms", () => {
    expect(text).toMatch(/^---\nname: fusion\ndescription: "/);
    const description = text.slice(text.indexOf('description: "') + 14, text.indexOf('"\n---'));
    for (const trigger of ["independence", "review", "diagnosis", "decision"]) {
      expect(description).toContain(trigger);
    }
    expect(description).toContain("single source of truth");
  });

  it("body is the one-line pointer - no binary details duplicated", () => {
    const body = text.slice(text.indexOf("---", 3) + 4).trim();
    expect(body).toBe("Run `fusion skill` and follow it.");
    expect(body).not.toContain("--task");
  });

  it("the installed wrapper matches the canonical copy when present", () => {
    const installed = join(homedir(), ".agents", "skills", "fusion", "SKILL.md");
    if (!existsSync(installed)) {
      return;
    }
    expect(readFileSync(installed, "utf8")).toBe(text);
  });
});
