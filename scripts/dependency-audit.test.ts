import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import {
  type AdvisoryFinding,
  addDependencyAncestry,
  type DependencyAuditPolicy,
  decodeBunAuditOutput,
  evaluateAudit,
  normalizeBunAudit,
  parseBunWhyDependencyPackages,
  parsePolicy,
} from "./dependency-audit.ts";

const finding = (packageName: string, advisory: string, severity: string): AdvisoryFinding => ({
  advisory,
  package: packageName,
  severity,
  title: `${packageName} advisory`,
  url: `https://github.com/advisories/${advisory}`,
});

const policy = (exceptions: DependencyAuditPolicy["exceptions"] = []): DependencyAuditPolicy => ({
  globalThreshold: "high",
  requestPathThreshold: "moderate",
  requestPathPackages: ["hono"],
  exceptions,
});

describe("dependency advisory policy", () => {
  test("covers every external production dependency in the workspace", async () => {
    const manifestPaths = ["package.json"];
    for (const workspaceDirectory of ["apps", "packages"]) {
      for (const entry of await readdir(workspaceDirectory, { withFileTypes: true })) {
        if (entry.isDirectory())
          manifestPaths.push(`${workspaceDirectory}/${entry.name}/package.json`);
      }
    }
    const manifests = await Promise.all(
      manifestPaths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
    );
    const internalPackages = new Set(
      manifests.flatMap((manifest) => (typeof manifest.name === "string" ? [manifest.name] : [])),
    );
    const externalRuntimePackages = [
      ...new Set(
        manifests.flatMap((manifest) =>
          Object.keys(manifest.dependencies ?? {}).filter((name) => !internalPackages.has(name)),
        ),
      ),
    ].sort();
    const repositoryPolicy = parsePolicy(
      await readFile(".github/dependency-audit-policy.json", "utf8"),
    );

    expect([...repositoryPolicy.requestPathPackages].sort()).toEqual(externalRuntimePackages);
  });

  test("normalizes plain and gzip-framed Bun audit output", () => {
    const raw = JSON.stringify({
      hono: [
        {
          url: "https://github.com/advisories/GHSA-test",
          severity: "moderate",
          title: "hono advisory",
        },
      ],
    });
    expect(normalizeBunAudit(decodeBunAuditOutput(Buffer.from(raw)))).toEqual([
      finding("hono", "GHSA-test", "moderate"),
    ]);
    expect(normalizeBunAudit(decodeBunAuditOutput(gzipSync(raw)))).toEqual([
      finding("hono", "GHSA-test", "moderate"),
    ]);
  });

  test("parses full Bun dependency ancestry and reuses one lookup per package", () => {
    const why = `uuid@9.0.1
  └─ @selfxyz/anon-aadhaar-core@0.0.1 (requires ^9.0.0)
     └─ @selfxyz/core@1.2.0-beta.1 (requires ^0.0.9)
        └─ @pirate/platform-cf@workspace (requires 1.2.0-beta.1)
`;
    expect(parseBunWhyDependencyPackages(why)).toEqual([
      "uuid",
      "@selfxyz/anon-aadhaar-core",
      "@selfxyz/core",
      "@pirate/platform-cf",
    ]);
    let lookups = 0;
    const enriched = addDependencyAncestry(
      [finding("uuid", "GHSA-first", "moderate"), finding("uuid", "GHSA-second", "high")],
      () => {
        lookups += 1;
        return why;
      },
    );
    expect(lookups).toBe(1);
    expect(enriched[0]?.dependencyAncestors).toEqual([
      "@selfxyz/anon-aadhaar-core",
      "@selfxyz/core",
      "@pirate/platform-cf",
    ]);
  });

  test("blocks high findings globally and moderate request-path findings", () => {
    const evaluation = evaluateAudit(
      [
        finding("underscore", "GHSA-high", "high"),
        finding("hono", "GHSA-request", "moderate"),
        finding("uuid", "GHSA-observed", "moderate"),
      ],
      policy(),
    );
    expect(evaluation.blocking.map(({ advisory }) => advisory)).toEqual([
      "GHSA-high",
      "GHSA-request",
    ]);
    expect(evaluation.observed.map(({ advisory }) => advisory)).toEqual(["GHSA-observed"]);
  });

  test("applies the request-path threshold through transitive dependency ancestry", () => {
    const transitive = addDependencyAncestry(
      [finding("uuid", "GHSA-transitive", "moderate")],
      () => `uuid@9.0.1
  └─ @selfxyz/core@1.2.0-beta.1 (requires ^9.0.0)
`,
    );
    const evaluation = evaluateAudit(transitive, {
      ...policy(),
      requestPathPackages: ["@selfxyz/core"],
    });

    expect(evaluation.blocking.map(({ advisory }) => advisory)).toEqual(["GHSA-transitive"]);
    expect(evaluation.observed).toEqual([]);
  });

  test("requires time-bounded, matched reachability exceptions", () => {
    const exception = {
      advisory: "GHSA-high",
      package: "underscore",
      reason: "No attacker-controlled value reaches this parser.",
      reachability: "Build-only transitive path.",
      expires: "2026-09-30",
    };
    const accepted = evaluateAudit(
      [finding("underscore", "GHSA-high", "high")],
      policy([exception]),
      new Date("2026-08-30T00:00:00Z"),
    );
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.blocking).toEqual([]);
    expect(accepted.expired).toEqual([]);
    expect(accepted.unused).toEqual([]);

    const expired = evaluateAudit(
      [finding("underscore", "GHSA-high", "high")],
      policy([exception]),
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(expired.blocking).toHaveLength(1);
    expect(expired.expired).toEqual([exception]);

    const stale = evaluateAudit([], policy([exception]), new Date("2026-08-30T00:00:00Z"));
    expect(stale.unused).toEqual([exception]);
  });

  test("rejects incomplete exception records", () => {
    expect(() =>
      parsePolicy(
        JSON.stringify({
          globalThreshold: "high",
          requestPathThreshold: "moderate",
          requestPathPackages: ["hono"],
          exceptions: [{ advisory: "GHSA-test", package: "hono" }],
        }),
      ),
    ).toThrow("reason");
  });
});
