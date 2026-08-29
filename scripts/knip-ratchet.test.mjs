import { describe, expect, test } from "bun:test";
import {
  countKnipIssues,
  evaluateBaselineAgreement,
  evaluateRatchet,
  parseDocumentedBaseline,
  parseMachineBaseline,
} from "./knip-ratchet.mjs";

const baseline = { files: 0, exports: 2, types: 1, duplicates: 0 };

const report = (exportNames) => ({
  issues: [
    {
      files: [],
      exports: exportNames.map((name) => ({ name })),
      types: [{ name: "ReviewedType" }],
      duplicates: [],
    },
  ],
});

describe("Knip hygiene ratchet", () => {
  test("counts tracked Knip JSON issue categories", () => {
    expect(countKnipIssues(report(["ReviewedOne", "ReviewedTwo"]))).toEqual(baseline);
  });

  test("rejects an isolated undocumented unused export fixture", () => {
    const actual = countKnipIssues(report(["ReviewedOne", "ReviewedTwo", "UnexpectedExport"]));
    expect(evaluateRatchet(actual, baseline)).toEqual(["exports: 3 exceeds documented baseline 2"]);
  });

  test("allows findings to decrease", () => {
    const actual = countKnipIssues(report(["ReviewedOne"]));
    expect(evaluateRatchet(actual, baseline)).toEqual([]);
  });

  test("requires prose and machine baselines to agree", () => {
    const machine = parseMachineBaseline(JSON.stringify({ schema_version: 1, counts: baseline }));
    const documented = parseDocumentedBaseline(
      "Unused exports: 2. Unused exported types: 1. Unused files: 0. Duplicate exports: 0.",
    );
    expect(evaluateBaselineAgreement(machine, documented)).toEqual([]);
  });
});
