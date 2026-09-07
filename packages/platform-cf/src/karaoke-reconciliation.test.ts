import { describe, expect, it } from "bun:test";
import { makeKaraokeReconciliationFixture } from "../../testing/src/karaoke-reconciliation-fixture.ts";
import { verifyKaraokeReconciliation } from "./karaoke-reconciliation.ts";
import { reconciliationDigest } from "./karaoke-reconciliation-evidence.ts";
import { parseKaraokeReconciliationReceipt } from "./karaoke-reconciliation-schema.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "./karaoke-reset-installation.ts";

type Options = NonNullable<Parameters<typeof makeKaraokeReconciliationFixture>[2]>;
const fixture = (options?: Options) =>
  makeKaraokeReconciliationFixture(KARAOKE_RESET_OBJECT_IDS, reconciliationDigest, options);
const verify = (value: ReturnType<typeof fixture>) =>
  verifyKaraokeReconciliation(value.port, value.now);
function required<A>(value: A | undefined): A {
  if (value === undefined) throw new Error("missing_fixture_value");
  return value;
}

function cleanupAt(index: number): Pick<Options, "evidence" | "edit"> {
  const response = (status: number) => ({
    endpointKind: "staging-bucket-s3",
    bucket: "staging-audio",
    requestId: "fixture-request",
    status,
  });
  return {
    evidence: (_phase, kind, data, current) => {
      if (current !== index) return data;
      if (kind === "before-list") {
        const { key } = data as { key: string };
        return {
          key,
          pages: [
            {
              marker: null,
              nextMarker: { key, uploadId: "one" },
              succeeded: true,
              prefix: key,
              response: response(200),
              uploads: [{ key, uploadId: "one" }],
            },
            {
              marker: { key, uploadId: "one" },
              nextMarker: null,
              succeeded: true,
              prefix: key,
              response: response(200),
              uploads: [{ key, uploadId: "two" }],
            },
          ],
        };
      }
      if (kind === "before-head")
        return { ...(data as object), state: "present", response: response(200) };
      return data;
    },
    edit: (_phase, receipt, add, current) => {
      if (current !== index) return;
      const key = (receipt.mapping as { key: string }).key;
      receipt.actionsEvidenceId = add([
        { kind: "abort", key, uploadId: "one", outcome: "succeeded", response: response(204) },
        { kind: "abort", key, uploadId: "two", outcome: "not-found", response: response(404) },
        { kind: "delete", key, uploadId: null, outcome: "succeeded", response: response(204) },
      ]);
      Object.assign(receipt.observations as object, {
        beforeUploadCount: 2,
        beforeHead: "present",
      });
      receipt.outcome = "cleaned-to-empty";
    },
  };
}

describe("staging reconciliation evidence", () => {
  it("loads the owner disposition instead of trusting an unresolved digest", async () => {
    const missing = fixture();
    missing.artifacts.delete(missing.manifest.residualDispositionId);
    await expect(verify(missing)).rejects.toThrow();
    const changed = fixture();
    changed.artifacts.set(changed.manifest.residualDispositionId, "{}");
    await expect(verify(changed)).rejects.toThrow("disposition_digest_mismatch");
  });
  it("admits exact-key cleanup with exhaustive multi-page upload listings", async () => {
    expect((await verify(fixture(cleanupAt(1)))).resetAdmission).toBe("eligible");
  });
  it("does not close retention when the follow-up discovers and cleans late audio", async () => {
    expect((await verify(fixture({ retention: true, ...cleanupAt(3) }))).retentionStatus).toBe(
      "pending",
    );
  });
  it("requires a new clean retirement baseline and next-day pass after a late finding", async () => {
    const value = fixture({
      retention: true,
      phases: ["post-fence", "pre-reset", "retirement", "follow-up", "retirement", "follow-up"],
      ...cleanupAt(3),
    });
    expect((await verify(value)).retentionStatus).toBe("observed-stable");
  });
  it("admits reset without changing a false instance quiescence fact", async () => {
    const value = fixture();
    const before = [...value.artifacts];
    const result = await verify(value);
    expect(result.resetAdmission).toBe("eligible");
    expect(result.retentionStatus).toBe("pending");
    expect(result.latestPasses).toHaveLength(6);
    expect(result.latestPasses.every((pass) => pass.quiescenceEstablished === false)).toBe(true);
    expect([...value.artifacts]).toEqual(before);
  });
  it("closes retention only with retired markers and next-day observations", async () => {
    const result = await verify(fixture({ retention: true }));
    expect(result.resetAdmission).toBe("blocked");
    expect(result.retentionStatus).toBe("observed-stable");
  });
  it("keeps retirement alone pending", async () => {
    const value = fixture({ retention: true });
    for (const target of value.manifest.targets) target.receiptIds.pop();
    expect((await verify(value)).retentionStatus).toBe("pending");
  });
  it("validates negative authority evidence without pretending to list R2", async () => {
    expect((await verify(fixture({ negative: true }))).resetAdmission).toBe("eligible");
    expect((await verify(fixture({ negative: true, retention: true }))).retentionStatus).toBe(
      "observed-stable",
    );
  });
  it("blocks uncertain negative history", async () => {
    const value = fixture({
      negative: true,
      evidence: (_phase, kind, data) =>
        kind === "history" ? { storageNeverDeleted: false, namespaceUnchanged: true } : data,
      edit: (_phase, receipt) => {
        receipt.outcome = "incomplete";
      },
    });
    // A pre-reset phase cannot follow an unsuccessful initial pass.
    await expect(verify(value)).rejects.toThrow();
  });
  it("rejects missing and duplicate targets", async () => {
    const missing = fixture();
    missing.manifest.targets.pop();
    await expect(verify(missing)).rejects.toThrow();
    const duplicate = fixture();
    duplicate.manifest.targets[1] = required(duplicate.manifest.targets[0]);
    await expect(verify(duplicate)).rejects.toThrow();
  });
  it("rejects unknown, digest-only and tampered artifacts", async () => {
    const missing = fixture();
    missing.manifest.entries = [];
    await expect(verify(missing)).rejects.toThrow("untrusted_reference");
    const tampered = fixture();
    const id = required(required(tampered.manifest.targets[0]).receiptIds[0]);
    tampered.artifacts.set(id, `${tampered.artifacts.get(id)} `);
    await expect(verify(tampered)).rejects.toThrow("digest_mismatch");
  });
  it("does not read artifacts when manifest authentication fails", async () => {
    let reads = 0;
    await expect(
      verifyKaraokeReconciliation(
        {
          async readCurrentAuthenticatedManifest() {
            throw new Error("operator_denied");
          },
          async readArtifact() {
            reads++;
            return "";
          },
        },
        fixture().now,
      ),
    ).rejects.toThrow("operator_denied");
    expect(reads).toBe(0);
  });
  it("rejects cross-object, generation and epoch substitutions", async () => {
    const value = fixture();
    required(value.manifest.targets[0]).receiptIds = required(value.manifest.targets[1]).receiptIds;
    await expect(verify(value)).rejects.toThrow();
    await expect(
      verify(
        fixture({
          edit: (_phase, receipt) => {
            receipt.target = { ...(receipt.target as object), generation: "other" };
          },
        }),
      ),
    ).rejects.toThrow();
    const epoch = fixture();
    epoch.manifest.epoch = "c".repeat(64);
    await expect(verify(epoch)).rejects.toThrow();
  });
  it("blocks stale current fences and rejects reused keys", async () => {
    const stale = fixture();
    stale.manifest.currentFenceEpoch = "c".repeat(64);
    expect((await verify(stale)).resetAdmission).toBe("blocked");
    const reused = fixture({ retention: true });
    required(reused.manifest.targets[0]).keyNotReused = false;
    await expect(verify(reused)).rejects.toThrow();
  });
  for (const field of ["ingress", "producers", "databaseWrites", "reconnectDenied"] as const) {
    it(`rejects an unverified ${field} fence`, async () => {
      await expect(
        verify(
          fixture({
            evidence: (_phase, kind, data) =>
              kind === "fence" ? { ...(data as object), [field]: false } : data,
          }),
        ),
      ).rejects.toThrow();
    });
  }
  it("rejects runtime sessions still present", async () => {
    await expect(
      verify(
        fixture({
          evidence: (_phase, kind, data) =>
            kind === "fence" ? { ...(data as object), runtimeSessions: 1 } : data,
        }),
      ),
    ).rejects.toThrow();
  });
  it("does not call truncated pagination or provider denial empty", async () => {
    for (const failure of ["truncated", "denied"]) {
      const value = fixture({
        evidence: (_phase, kind, data) => {
          if (kind !== "after-list") return data;
          const list = data as { key: string; pages: object[] };
          return {
            key: list.key,
            pages: [
              {
                ...required(list.pages[0]),
                marker: null,
                uploads: [],
                succeeded: failure !== "denied",
                nextMarker: failure === "truncated" ? { key: list.key, uploadId: "pending" } : null,
              },
            ],
          };
        },
      });
      await expect(verify(value)).rejects.toThrow();
    }
  });
  it("rejects bucket denial and non-exact cleanup", async () => {
    await expect(
      verify(
        fixture({
          evidence: (_phase, kind, data) =>
            kind === "after-head" ? { ...(data as object), bucketVerified: false } : data,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      verify(
        fixture({
          evidence: (_phase, kind, data) =>
            kind === "actions"
              ? [
                  {
                    kind: "delete",
                    key: "karaoke/account/another.pcm",
                    uploadId: null,
                    outcome: "succeeded",
                  },
                ]
              : data,
        }),
      ),
    ).rejects.toThrow();
  });
  it("rejects falsely classified HEAD absence and wrong provider bucket", async () => {
    for (const override of [
      { status: 403 },
      { bucket: "another-bucket" },
      { endpointKind: "custom-domain" },
    ]) {
      await expect(
        verify(
          fixture({
            evidence: (_phase, kind, data) => {
              if (kind !== "after-head") return data;
              const head = data as { response: object };
              return { ...head, response: { ...head.response, ...override } };
            },
          }),
        ),
      ).rejects.toThrow();
    }
  });
  it("rejects early follow-up and missing release evidence", async () => {
    await expect(
      verify(
        fixture({
          retention: true,
          edit: (phase, receipt) => {
            if (phase === "follow-up") {
              receipt.startedAt = "2026-09-07T10:00:02.099Z";
              receipt.endedAt = "2026-09-07T10:00:02.100Z";
            }
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      verify(
        fixture({
          retention: true,
          edit: (phase, receipt) => {
            if (phase === "follow-up") receipt.releaseEvidenceId = null;
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it("rejects future, reversed and invalid dates and unknown fields", async () => {
    for (const change of [
      { endedAt: "2026-09-12T00:00:00.000Z" },
      { endedAt: "2026-09-01T00:00:00.000Z" },
      { startedAt: "2026-02-30T00:00:00.000Z" },
      { unexpected: true },
    ])
      await expect(
        verify(fixture({ edit: (_phase, receipt) => Object.assign(receipt, change) })),
      ).rejects.toThrow();
  });
  it("strictly parses a receipt and rejects forged success flags", async () => {
    const value = fixture();
    const id = required(required(value.manifest.targets[0]).receiptIds[0]);
    const receipt = JSON.parse(required(value.artifacts.get(id))).data;
    expect(parseKaraokeReconciliationReceipt(receipt).phase).toBe("post-fence");
    await expect(
      verify(
        fixture({
          edit: (_phase, input) => {
            input.outcome = "cleaned-to-empty";
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
