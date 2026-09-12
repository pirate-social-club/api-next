import { describe, expect, test } from "bun:test";
import {
  isBoundedVersion,
  readSchemaCutoverState,
  schemaCompatibilityRefusal,
} from "./schema-compatibility.ts";

describe("HNS lifecycle schema compatibility", () => {
  test("a pre-cutover schema admits the running service", () => {
    expect(
      schemaCompatibilityRefusal({
        state: null,
        service_version: "pirate-hns-authority-provisioner-v2",
        job_envelope_version: "hns-lifecycle-job-envelope-v1",
      }),
    ).toBeNull();
  });

  test("a compatible pair is admitted", () => {
    expect(
      schemaCompatibilityRefusal({
        state: {
          cutover_version: "0169",
          compatible_service_versions: ["pirate-hns-authority-provisioner-v2"],
          compatible_job_envelope_versions: ["hns-lifecycle-job-envelope-v1"],
        },
        service_version: "pirate-hns-authority-provisioner-v2",
        job_envelope_version: "hns-lifecycle-job-envelope-v1",
      }),
    ).toBeNull();
  });

  test("an old service version is refused by name", () => {
    const refusal = schemaCompatibilityRefusal({
      state: {
        cutover_version: "0169",
        compatible_service_versions: ["pirate-hns-authority-provisioner-v2"],
        compatible_job_envelope_versions: ["hns-lifecycle-job-envelope-v1"],
      },
      service_version: "pirate-hns-authority-provisioner-v1",
      job_envelope_version: "hns-lifecycle-job-envelope-v1",
    });
    expect(refusal).toMatchObject({
      outcome: "schema_incompatible",
      missing: "service_version",
      cutover_version: "0169",
    });
  });

  test("an unsupported job envelope is refused by name", () => {
    const refusal = schemaCompatibilityRefusal({
      state: {
        cutover_version: "0169",
        compatible_service_versions: ["pirate-hns-authority-provisioner-v2"],
        compatible_job_envelope_versions: ["hns-lifecycle-job-envelope-v2"],
      },
      service_version: "pirate-hns-authority-provisioner-v2",
      job_envelope_version: "hns-lifecycle-job-envelope-v1",
    });
    expect(refusal?.missing).toBe("job_envelope_version");
  });

  test("the refusal is bounded and redacted", () => {
    const long = "x".repeat(300);
    const refusal = schemaCompatibilityRefusal({
      state: {
        cutover_version: long,
        compatible_service_versions: [long],
        compatible_job_envelope_versions: [long],
      },
      service_version: "safe-version",
      job_envelope_version: "safe-envelope",
    });
    expect(refusal?.cutover_version?.length).toBe(128);
    expect(refusal?.compatible_service_versions[0]?.length).toBe(128);
    const control = schemaCompatibilityRefusal({
      state: {
        cutover_version: "0169",
        compatible_service_versions: ["bad\u0000version"],
        compatible_job_envelope_versions: ["hns-lifecycle-job-envelope-v1"],
      },
      service_version: "pirate-hns-authority-provisioner-v2",
      job_envelope_version: "hns-lifecycle-job-envelope-v1",
    });
    expect(control?.compatible_service_versions[0]).toBe("<redacted>");
  });

  test("bounded version validation admits only safe identifiers", () => {
    expect(isBoundedVersion("pirate-hns-authority-provisioner-v2")).toBe(true);
    expect(isBoundedVersion("")).toBe(false);
    expect(isBoundedVersion(" leading")).toBe(false);
    expect(isBoundedVersion("trailing ")).toBe(false);
    expect(isBoundedVersion("bad\u0000value")).toBe(false);
    expect(isBoundedVersion("x".repeat(129))).toBe(false);
    expect(isBoundedVersion(42)).toBe(false);
  });

  test("a missing cutover table is pre-cutover rather than an error", async () => {
    const state = await readSchemaCutoverState(async () => {
      throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
    });
    expect(state).toBeNull();
  });

  test("a malformed compatibility record is an error, not a refusal", async () => {
    await expect(
      readSchemaCutoverState(async () => ({
        rows: [
          {
            cutover_version: "0169",
            compatible_service_versions: "not-an-array",
            compatible_job_envelope_versions: [],
          },
        ],
      })),
    ).rejects.toThrow(/malformed/u);
  });

  test("a valid compatibility record is decoded", async () => {
    const state = await readSchemaCutoverState(async () => ({
      rows: [
        {
          cutover_version: "0169",
          compatible_service_versions: ["pirate-hns-authority-provisioner-v2"],
          compatible_job_envelope_versions: ["hns-lifecycle-job-envelope-v1"],
        },
      ],
    }));
    expect(state).toEqual({
      cutover_version: "0169",
      compatible_service_versions: ["pirate-hns-authority-provisioner-v2"],
      compatible_job_envelope_versions: ["hns-lifecycle-job-envelope-v1"],
    });
  });
});
