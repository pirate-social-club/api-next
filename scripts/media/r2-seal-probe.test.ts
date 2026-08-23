import { describe, expect, test } from "bun:test";

import {
  type CopyObjectRequest,
  encodeCopySource,
  FakeR2Transport,
  type HeadObjectResponse,
  loadHostileFixtures,
  probeScenario,
  type R2SealTransport,
  redactEvidence,
  runLocalDryRun,
} from "./r2-seal-probe";
import type { ScenarioName, SealFixture } from "./r2-seal-probe-fixtures";

async function fixtureByName(name: ScenarioName): Promise<SealFixture> {
  const fixtures = await loadHostileFixtures();
  const fixture = fixtures.scenarios.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`${name} fixture missing`);
  return fixture;
}

describe("local R2 seal probe", () => {
  test("runs every hostile fixture with provider contact and credentials disabled", async () => {
    const evidence = await runLocalDryRun(await loadHostileFixtures());
    expect(evidence.mode).toBe("local-dry-run");
    expect(evidence.transport).toBe("fake");
    expect(evidence.provider_contacted).toBe(false);
    expect(evidence.credentials_read).toBe(false);
    expect(evidence.safety.secrets_emitted).toBe(false);
    expect(evidence.scenarios.map(({ name }) => name)).toEqual([
      "success",
      "source-missing",
      "copy-source-missing",
      "expectation-size-mismatch",
      "expectation-content-type-mismatch",
      "expectation-checksum-mismatch",
      "expectation-checksum-missing",
      "source-overwritten-before-copy",
      "destination-conflict",
      "simultaneous-source-destination-race",
      "destination-appears-before-copy",
      "malformed-404",
      "generic-404",
      "no-such-bucket",
      "copy-provider-error",
      "nonstandard-412",
      "verification-etag-mismatch",
      "verification-size-mismatch",
      "verification-content-type-mismatch",
      "verification-checksum-mismatch",
      "verification-version-mismatch",
      "verification-destination-missing",
      "verification-provider-error",
      "multipart-etag",
      "unquoted-etag",
      "weak-etag",
      "ambiguous-412",
    ]);
  });

  test("encodes the source bucket and each key segment without encoding separators", () => {
    expect(encodeCopySource("fixture-bucket", "folder/song + é ?#%!'()*.wav")).toBe(
      "/fixture-bucket/folder/song%20%2B%20%C3%A9%20%3F%23%25%21%27%28%29%2A.wav",
    );
  });

  test("preserves the observed source ETag and sends the exact conditional copy", async () => {
    const fixture = await fixtureByName("success");
    const transport = new FakeR2Transport(fixture);

    const evidence = await probeScenario(fixture, transport);
    const copy = transport.calls.find((call) => call.kind === "copy");
    expect(evidence.outcome).toBe("success");
    expect(evidence.observed_source_etag).toBe('"etag-success-source"');
    expect(evidence.observed_destination_etag).toBe('"etag-success-source"');
    expect(evidence.observed_destination_size_bytes).toBe(1024);
    expect(evidence.observed_destination_content_type).toBe("audio/mpeg");
    expect(evidence.version_binding).toBe("matched");
    expect(evidence.destination_verified).toBe(true);
    expect(evidence.source_head_calls).toBe(1);
    expect(copy).toEqual({
      kind: "copy",
      sourceBucket: fixture.sourceBucket,
      destinationBucket: fixture.destinationBucket,
      sourceKey: fixture.sourceKey,
      destinationKey: fixture.destinationKey,
      headers: {
        "x-amz-copy-source": encodeCopySource(fixture.sourceBucket, fixture.sourceKey),
        "x-amz-copy-source-if-match": '"etag-success-source"',
        "cf-copy-destination-if-none-match": "*",
      },
    });
  });

  test("the fake rejects drifted coordinates and destination condition headers", async () => {
    const fixture = await fixtureByName("success");
    const request = {
      sourceBucket: fixture.sourceBucket,
      destinationBucket: fixture.destinationBucket,
      sourceKey: fixture.sourceKey,
      destinationKey: fixture.destinationKey,
      headers: {
        "x-amz-copy-source": encodeCopySource(fixture.sourceBucket, fixture.sourceKey),
        "x-amz-copy-source-if-match": fixture.source?.etag ?? "",
        "cf-copy-destination-if-none-match": "*",
      },
    } satisfies CopyObjectRequest;

    expect(
      await new FakeR2Transport(fixture).copyObject({
        ...request,
        destinationKey: "fixture/immutable/drifted.bin",
      }),
    ).toMatchObject({ kind: "error", code: "NoSuchKey" });
    expect(
      await new FakeR2Transport(fixture).copyObject({
        ...request,
        headers: { ...request.headers, "cf-copy-destination-if-none-match": "wrong" as "*" },
      }),
    ).toMatchObject({ kind: "error", code: "MissingDestinationCondition" });
  });

  test("maps only parsed NoSuchKey responses to source_missing", async () => {
    const sourceMissing = await fixtureByName("source-missing");
    const copyMissing = await fixtureByName("copy-source-missing");
    const malformed = await fixtureByName("malformed-404");
    const generic = await fixtureByName("generic-404");
    const noSuchBucket = await fixtureByName("no-such-bucket");

    expect((await probeScenario(sourceMissing, new FakeR2Transport(sourceMissing))).outcome).toBe(
      "source_missing",
    );
    const copyMissingEvidence = await probeScenario(copyMissing, new FakeR2Transport(copyMissing));
    expect(copyMissingEvidence.outcome).toBe("source_missing");
    expect(copyMissingEvidence.conditional_copy_calls).toBe(1);
    for (const fixture of [malformed, generic, noSuchBucket]) {
      expect((await probeScenario(fixture, new FakeR2Transport(fixture))).outcome).toBe(
        "provider_response_unknown",
      );
    }
  });

  test("fails all declared expectation mismatches before copying", async () => {
    const names = [
      "expectation-size-mismatch",
      "expectation-content-type-mismatch",
      "expectation-checksum-mismatch",
      "expectation-checksum-missing",
    ] as const;

    for (const name of names) {
      const fixture = await fixtureByName(name);
      const transport = new FakeR2Transport(fixture);
      const evidence = await probeScenario(fixture, transport);
      expect(evidence.outcome).toBe("expectation_mismatch");
      expect(evidence.conditional_copy_calls).toBe(0);
      expect(transport.calls.filter((call) => call.kind === "copy")).toHaveLength(0);
    }
  });

  test("preserves a quoted multipart ETag only as the source copy condition", async () => {
    const fixture = await fixtureByName("multipart-etag");
    const transport = new FakeR2Transport(fixture);
    const evidence = await probeScenario(fixture, transport);
    const copy = transport.calls.find((call) => call.kind === "copy");

    expect(evidence.outcome).toBe("success");
    expect(evidence.observed_source_etag).toBe('"f77dc0eecdebcd774a2a22cb393ad2ff-2"');
    expect(evidence.observed_destination_etag).toBe('"9e107d9d372bb6826bd81d3542a419d6"');
    expect(evidence.observed_destination_size_bytes).toBe(5_243_904);
    expect(copy).toMatchObject({
      headers: {
        "x-amz-copy-source-if-match": '"f77dc0eecdebcd774a2a22cb393ad2ff-2"',
        "cf-copy-destination-if-none-match": "*",
      },
    });
  });

  test("fails closed for every 412 without a follow-up HEAD, retry, or second copy", async () => {
    const raceNames = [
      "source-overwritten-before-copy",
      "destination-conflict",
      "simultaneous-source-destination-race",
      "destination-appears-before-copy",
      "ambiguous-412",
    ] as const;

    for (const name of raceNames) {
      const fixture = await fixtureByName(name);
      const transport = new FakeR2Transport(fixture);
      const evidence = await probeScenario(fixture, transport);
      expect(evidence.outcome).toBe("conditional_precondition_ambiguous");
      expect(evidence.conditional_copy_status).toBe(412);
      expect(evidence.conditional_copy_calls).toBe(1);
      expect(evidence.automatic_retry).toBe(false);
      expect(evidence.destination_head_calls).toBe(0);
      expect(transport.calls.filter((call) => call.kind === "copy")).toHaveLength(1);
    }
  });

  test("keeps non-conditional copy failures provider-unknown", async () => {
    for (const name of ["copy-provider-error", "nonstandard-412"] as const) {
      const fixture = await fixtureByName(name);
      const evidence = await probeScenario(fixture, new FakeR2Transport(fixture));
      expect(evidence.outcome).toBe("provider_response_unknown");
      expect(evidence.destination_head_calls).toBe(0);
    }
  });

  test("distinguishes every destination verification failure without recovery copy", async () => {
    const cases = [
      ["verification-etag-mismatch", "etag_mismatch"],
      ["verification-size-mismatch", "size_mismatch"],
      ["verification-content-type-mismatch", "content_type_mismatch"],
      ["verification-checksum-mismatch", "checksum_mismatch"],
      ["verification-version-mismatch", "version_mismatch"],
      ["verification-destination-missing", "destination_missing"],
      ["verification-provider-error", "provider_error"],
    ] as const;

    for (const [name, failure] of cases) {
      const fixture = await fixtureByName(name);
      const transport = new FakeR2Transport(fixture);
      const evidence = await probeScenario(fixture, transport);
      expect(evidence.outcome).toBe("verification_mismatch");
      expect(evidence.verification_failure).toBe(failure);
      expect(evidence.conditional_copy_calls).toBe(1);
      expect(evidence.destination_head_calls).toBe(1);
      expect(transport.calls.filter((call) => call.kind === "copy")).toHaveLength(1);
    }
  });

  test("requires a matched destination version before reporting success", async () => {
    const fixture = {
      name: "success",
      sourceBucket: "fixture-bucket",
      destinationBucket: "fixture-bucket",
      sourceKey: "fixture/source",
      destinationKey: "fixture/destination",
      source: { etag: '"quoted-etag"', sizeBytes: 1, contentType: "audio/mpeg" },
      destination: null,
      expectedSizeBytes: 1,
      expectedContentType: "audio/mpeg",
    } as const;
    const evidence = await probeScenario(fixture, new FakeR2Transport(fixture));
    expect(evidence.outcome).toBe("verification_mismatch");
    expect(evidence.version_binding).toBe("unavailable");
    expect(evidence.verification_failure).toBe("version_unavailable");
  });

  test("models destination appearance as a copy-time race without inventing a preflight", async () => {
    const fixture = await fixtureByName("destination-appears-before-copy");
    const transport = new FakeR2Transport(fixture);
    const evidence = await probeScenario(fixture, transport);
    expect(evidence.outcome).toBe("conditional_precondition_ambiguous");
    expect(evidence.destination_head_calls).toBe(0);
    expect(transport.calls.filter((call) => call.kind === "head")).toHaveLength(1);
    expect(transport.calls.filter((call) => call.kind === "copy")).toHaveLength(1);
  });

  test("preserves unusual ETags without treating them as checksums", async () => {
    for (const name of ["unquoted-etag", "weak-etag"] as const) {
      const fixture = await fixtureByName(name);
      const transport = new FakeR2Transport(fixture);
      const evidence = await probeScenario(fixture, transport);
      const copy = transport.calls.find((call) => call.kind === "copy");
      expect(evidence.outcome).toBe("success");
      expect(copy).toMatchObject({
        headers: { "x-amz-copy-source-if-match": fixture.source?.etag },
      });
    }
  });

  test("projects evidence through a schema-matched security allowlist", async () => {
    const fixture = await fixtureByName("success");
    const scenario = await probeScenario(fixture, new FakeR2Transport(fixture));
    const polluted = {
      ...scenario,
      authorization: "Bearer forbidden-secret",
      request_url: "https://credential.invalid/?signature=forbidden-secret",
      raw_body: "forbidden-secret",
    };
    const evidence = redactEvidence({ scenarios: [polluted] });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("forbidden-secret");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("request_url");
    expect(serialized).not.toContain("raw_body");
    expect(() =>
      redactEvidence({
        scenarios: [{ ...scenario, source_key: "https://credential.invalid/?signature=secret" }],
      }),
    ).toThrow("unsafe source_key value");

    const schema = (await Bun.file(
      new URL("../../docs/evidence/media-r2-sealing/schema.json", import.meta.url),
    ).json()) as {
      required: string[];
      $defs: { scenario: { required: string[] } };
    };
    expect(Object.keys(evidence).sort()).toEqual([...schema.required].sort());
    expect(Object.keys(evidence.scenarios[0] ?? {}).sort()).toEqual(
      [...schema.$defs.scenario.required].sort(),
    );
  });

  test("produces deterministic local evidence", async () => {
    expect(await runLocalDryRun()).toEqual(await runLocalDryRun());
  });

  test("accepts an injected transport without adding a network implementation", async () => {
    const fixture = {
      name: "success",
      sourceBucket: "fixture-bucket",
      destinationBucket: "fixture-bucket",
      sourceKey: "fixture/source",
      destinationKey: "fixture/destination",
      source: {
        etag: '"quoted-etag"',
        sizeBytes: 1,
        contentType: "audio/mpeg",
        versionId: "source-version",
      },
      destination: null,
      expectedSizeBytes: 1,
      expectedContentType: "audio/mpeg",
      destinationVersionIdAfterCopy: "destination-version",
    } as const;
    const calls: string[] = [];
    const transport: R2SealTransport = {
      async headObject(bucket, key): Promise<HeadObjectResponse> {
        calls.push(`head:${bucket}:${key}`);
        return key === fixture.sourceKey
          ? {
              kind: "found",
              status: 200,
              code: "OK",
              etag: '"quoted-etag"',
              sizeBytes: 1,
              contentType: "audio/mpeg",
              versionId: "source-version",
            }
          : {
              kind: "found",
              status: 200,
              code: "OK",
              etag: '"quoted-etag"',
              sizeBytes: 1,
              contentType: "audio/mpeg",
              versionId: "destination-version",
            };
      },
      async copyObject(request) {
        calls.push(
          `copy:${request.headers["x-amz-copy-source-if-match"]}:${request.headers["cf-copy-destination-if-none-match"]}`,
        );
        return {
          kind: "copied",
          status: 200,
          code: "OK",
          destinationEtag: '"quoted-etag"',
          destinationVersionId: "destination-version",
        };
      },
    };

    const evidence = await probeScenario(fixture, transport);
    expect(evidence.outcome).toBe("success");
    expect(calls).toEqual([
      "head:fixture-bucket:fixture/source",
      'copy:"quoted-etag":*',
      "head:fixture-bucket:fixture/destination",
    ]);
  });
});
