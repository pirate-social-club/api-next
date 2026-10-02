import { describe, expect, test } from "bun:test";
import { ControlPlaneStatementFailed } from "@pirate/application";
import { alignmentRecoveryAuthority } from "../../application/src/media/alignment-recovery.test-fixture.ts";
import {
  alignmentRecoveryTerminalMessage,
  readAlignmentRecoveryTerminalMessage,
  sanitizeAlignmentRecoveryLookupFailure,
} from "../../application/src/media/alignment-recovery-diagnostics.ts";
import { makeReadMediaAlignmentRecovery } from "./media-alignment-recovery-read.ts";

describe("alignment recovery lookup diagnostics", () => {
  const recovery = {
    state: "requested",
    recovery_action_id: "recovery-action",
    attempt_id: "recovery-attempt",
  };
  const ready = {
    status: "ready",
    current_artifact_ref: "artifact",
    current_artifact_revision: "1",
    artifact_sha256: "b".repeat(64),
    artifact: { segments: [] },
  };
  const cases = [
    { reason: "multiple_recovery_rows", authorization: [recovery, recovery], projection: [] },
    {
      reason: "malformed_recovery_identifiers",
      authorization: [{ ...recovery, attempt_id: " " }],
      projection: [],
    },
    {
      reason: "malformed_recovery_identifiers",
      authorization: [{ ...recovery, state: "completed", attempt_id: null }],
      projection: [],
    },
    { reason: "invalid_projection_row_count", authorization: [], projection: [] },
    { reason: "invalid_projection_row_count", authorization: [], projection: [ready, ready] },
    { reason: "unknown_projection_status", authorization: [], projection: [{ status: "corrupt" }] },
    {
      reason: "invalid_failure_code",
      authorization: [],
      projection: [{ status: "unavailable", failure_code: "secret-body" }],
    },
    { reason: "malformed_artifact", authorization: [], projection: [{ ...ready, artifact: [] }] },
    {
      reason: "malformed_artifact",
      authorization: [],
      projection: [{ ...ready, current_artifact_revision: "0" }],
    },
    {
      reason: "malformed_artifact",
      authorization: [],
      projection: [{ ...ready, artifact_sha256: "secret-body" }],
    },
  ] as const;
  for (const [index, item] of cases.entries()) {
    test(`${item.reason} preserves a stable reason (${index})`, async () => {
      const read = makeReadMediaAlignmentRecovery(async (statement) =>
        statement.label.endsWith("authorization") ? item.authorization : item.projection,
      );
      expect(await read(alignmentRecoveryAuthority())).toEqual({
        kind: "stale",
        reason: item.reason,
      });
    });
  }
  test("rejects invalid publication binding before any database read", async () => {
    const read = makeReadMediaAlignmentRecovery(async () => {
      throw new Error("must not query");
    });
    expect(await read(alignmentRecoveryAuthority({ postId: null }))).toEqual({
      kind: "stale",
      reason: "invalid_publication_binding",
    });
  });
  test("reads requested, pending and completed authority without losing the recovery identity", async () => {
    expect(
      await makeReadMediaAlignmentRecovery(async () => [recovery])(alignmentRecoveryAuthority()),
    ).toEqual({
      kind: "recovery",
      recoveryActionId: "recovery-action",
      attemptId: "recovery-attempt",
    });
    expect(
      await makeReadMediaAlignmentRecovery(async (statement) =>
        statement.label.endsWith("authorization") ? [] : [{ status: "pending" }],
      )(alignmentRecoveryAuthority()),
    ).toEqual({ kind: "pending" });
    expect(
      await makeReadMediaAlignmentRecovery(async (statement) =>
        statement.label.endsWith("authorization") ? [{ ...recovery, state: "completed" }] : [ready],
      )(alignmentRecoveryAuthority()),
    ).toMatchObject({
      kind: "committed",
      recoveryAttemptId: "recovery-attempt",
      result: { status: "ready", artifactRef: "artifact" },
    });
  });
  for (const query of [
    "media-processing.alignment-recovery-authorization",
    "media-processing.alignment-recovery",
  ] as const) {
    test(`retains safe cause and failing query ${query}`, async () => {
      const failure = new ControlPlaneStatementFailed({
        label: "secret SQL",
        sqlState: "40P01",
        constraint: "secret row",
        outcomeCertainty: "aborted",
      });
      const read = makeReadMediaAlignmentRecovery(async (statement) => {
        if (statement.label === query) throw failure;
        return [];
      });
      const result = await read(alignmentRecoveryAuthority());
      expect(result).toEqual({
        kind: "failed",
        reason: { errorClass: "ControlPlaneStatementFailed", code: "40P01", query },
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    });
  }
  test("redacts arbitrary error fields and accepts only closed terminal diagnostics", () => {
    const query = "media-processing.alignment-recovery-authorization";
    const reason = sanitizeAlignmentRecoveryLookupFailure(
      {
        _tag: "ControlPlaneStatementFailed",
        sqlState: "secret",
        message: "private lyrics",
        cause: "credential",
        label: "SELECT sensitive",
      },
      query,
    );
    expect(reason).toEqual({ errorClass: "ControlPlaneStatementFailed", code: null, query });
    const diagnostic = { outcome: "alignment_recovery_lookup_failed", reason } as const;
    const message = alignmentRecoveryTerminalMessage(diagnostic);
    expect(readAlignmentRecoveryTerminalMessage(message)).toEqual(diagnostic);
    expect(
      readAlignmentRecoveryTerminalMessage(`AlignmentRecoveryLookupTerminalError: ${message}`),
    ).toEqual(diagnostic);
    expect(message).not.toContain("secret");
    expect(
      readAlignmentRecoveryTerminalMessage(
        'media-alignment-recovery:{"outcome":"alignment_recovery_lookup_stale","reason":"private lyrics"}',
      ),
    ).toBeNull();
    expect(
      readAlignmentRecoveryTerminalMessage(`${message.slice(0, -1)},"raw":"credential"}`),
    ).toBeNull();
    expect(readAlignmentRecoveryTerminalMessage("unrelated provider error")).toBeNull();
  });
});
