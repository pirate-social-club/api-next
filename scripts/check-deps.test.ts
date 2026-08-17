import { describe, expect, test } from "bun:test";
import { providerBoundaryViolation } from "./check-provider-boundary.mjs";

const providerFile = "packages/platform-cf/src/verification/providers/fake.ts";

describe("provider dependency boundary", () => {
  test("allows only the stable verification seams for internal imports", () => {
    expect(providerBoundaryViolation(providerFile, "@pirate/application/verification")).toBe(
      undefined,
    );
    expect(providerBoundaryViolation(providerFile, "@pirate/domain/verification")).toBe(undefined);
    expect(providerBoundaryViolation(providerFile, "effect")).toBe(undefined);
    expect(providerBoundaryViolation(providerFile, "./local-helper.ts")).toBe(undefined);
  });

  test("rejects contracts, use cases, routes, generated modules, and other internal packages", () => {
    for (const spec of [
      "@pirate/contracts",
      "@pirate/application/use-cases/identity",
      "@pirate/http-worker/routes",
      "@pirate/domain/generated",
      "@pirate/platform-cf",
      "@pirate/domain/verification/eligibility",
      "@pirate/application/verification/internal",
    ]) {
      expect(providerBoundaryViolation(providerFile, spec)).toContain(
        "provider adapters may import",
      );
    }
    expect(providerBoundaryViolation(providerFile, "../routes/generated.ts")).toContain(
      "provider adapters may not use parent-relative imports",
    );
    expect(providerBoundaryViolation(providerFile, "./../routes/generated.ts")).toContain(
      "provider adapters may not use parent-relative imports",
    );
    expect(
      providerBoundaryViolation(
        providerFile,
        "@pirate/application/verification/../use-cases/content",
      ),
    ).toContain("provider adapters may not use parent-relative imports");
    expect(
      providerBoundaryViolation(providerFile, "@pirate/domain/verification/../generated"),
    ).toContain("provider adapters may not use parent-relative imports");
  });

  test("does not impose provider rules on unrelated files", () => {
    expect(
      providerBoundaryViolation("packages/platform-cf/src/feed-repository.ts", "@pirate/contracts"),
    ).toBe(undefined);
  });
});
