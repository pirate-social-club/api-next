import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Effect, Layer } from "effect";
import { makeMediaUploadStore } from "./media-upload-store.ts";

const responseBytes = new TextEncoder().encode('{"error":{"code":"conflict"}}');
const responseSha256 = "a".repeat(64);

const command = {
  communityId: "community_media",
  submissionId: "submission_media",
  actorUserId: "account_media",
  personaId: "persona_media",
  endpointTemplate: "/media-post-submissions/:submissionId/finalize",
  idempotencyKey: "finalize-missing",
  requestHash: "b".repeat(64),
  responseBytes,
  responseSha256,
  operationId: "operation_media",
  reservationId: "reservation_media",
  expectedCreationRevision: 1,
} as const;

function storeWith(
  respond: (statement: ControlPlaneStatement) => {
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number;
  },
) {
  const statements: ControlPlaneStatement[] = [];
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
    statements.push(statement);
    const result = respond(statement);
    return Effect.succeed({ rows: result.rows as readonly never[], rowCount: result.rowCount });
  };
  const db: ControlPlaneDb["Service"] = {
    execute,
    withTransaction: (use) => use({ execute }),
  };
  return {
    statements,
    store: makeMediaUploadStore(Layer.succeed(ControlPlaneDb, db)),
  };
}

describe("media upload PostgreSQL store adapter", () => {
  test("records source-missing replay only while the claimed submission remains pre-fence", async () => {
    const fixture = storeWith((statement) => {
      switch (statement.label) {
        case "media-upload.finalize-missing-lock":
          return { rows: [], rowCount: 1 };
        case "media-upload.finalize-missing-replay":
          return { rows: [], rowCount: 0 };
        case "media-upload.finalize-missing-current":
          return { rows: [{ operation_id: command.operationId }], rowCount: 1 };
        case "media-upload.finalize-missing-insert":
          return { rows: [], rowCount: 1 };
        default:
          throw new Error(`unexpected statement: ${statement.label}`);
      }
    });

    await expect(fixture.store.recordFinalizeSourceMissing(command)).resolves.toEqual({
      kind: "committed",
      submissionId: command.submissionId,
    });
    expect(fixture.statements.map(({ label }) => label)).toEqual([
      "media-upload.finalize-missing-lock",
      "media-upload.finalize-missing-replay",
      "media-upload.finalize-missing-current",
      "media-upload.finalize-missing-insert",
    ]);
    const current = fixture.statements[2];
    expect(current?.text).toContain("s.phase='awaiting_upload'");
    expect(current?.text).toContain("r.state='claimed'");
    expect(current?.values).toEqual([
      command.communityId,
      command.actorUserId,
      command.personaId,
      command.submissionId,
      command.operationId,
      command.expectedCreationRevision,
      command.reservationId,
    ]);
  });

  test("returns the exact stored replay without rechecking mutable submission state", async () => {
    const fixture = storeWith((statement) => {
      if (statement.label === "media-upload.finalize-missing-lock") {
        return { rows: [], rowCount: 1 };
      }
      if (statement.label === "media-upload.finalize-missing-replay") {
        return {
          rows: [
            {
              community_id: command.communityId,
              submission_id: command.submissionId,
              operation_id: command.operationId,
              request_hash: command.requestHash,
              response_snapshot_bytes: responseBytes,
              response_snapshot_sha256: responseSha256,
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`replay performed an extra statement: ${statement.label}`);
    });

    await expect(fixture.store.recordFinalizeSourceMissing(command)).resolves.toEqual({
      kind: "replay",
      submissionId: command.submissionId,
      operationId: command.operationId,
      bytes: responseBytes,
      sha256: responseSha256,
    });
    expect(fixture.statements.map(({ label }) => label)).toEqual([
      "media-upload.finalize-missing-lock",
      "media-upload.finalize-missing-replay",
    ]);
  });
});
