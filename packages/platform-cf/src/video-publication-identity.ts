import type { ControlPlaneTransaction } from "@pirate/application";
import { Effect } from "effect";

/** Called while holding the authoritative submission fence, before any Post write. */
export const requireVideoPublicationIdentityInTransaction = Effect.fn(
  "requireVideoPublicationIdentityInTransaction",
)(function* (
  tx: Pick<ControlPlaneTransaction, "execute">,
  input: {
    submissionId: string;
    operationId: string;
    postId: string;
  },
) {
  const rows = yield* tx.execute<Record<string, unknown>>({
    label: "video-publication.identity.require",
    text: "SELECT require_video_publication_identity_v1($1,$2,$3) AS post_id",
    values: [input.submissionId, input.operationId, input.postId],
    readonly: false,
  });
  if (rows.rows.length !== 1 || rows.rows[0]?.post_id !== input.postId)
    throw new Error("Video publication identity did not reconcile");
});

/** No generic slug allocator, candidate loop, or same-post alternate-alias success. */
export const ensureExactVideoReceiptAliasInTransaction = Effect.fn(
  "ensureExactVideoReceiptAliasInTransaction",
)(function* (
  tx: Pick<ControlPlaneTransaction, "execute">,
  input: {
    submissionId: string;
    operationId: string;
    postId: string;
  },
) {
  const rows = yield* tx.execute<Record<string, unknown>>({
    label: "video-publication.exact-alias.ensure",
    text: "SELECT ensure_exact_video_receipt_alias_v1($1,$2,$3) AS result",
    values: [input.submissionId, input.operationId, input.postId],
    readonly: false,
  });
  const result = rows.rows[0]?.result;
  if (rows.rows.length !== 1 || (result !== "inserted" && result !== "already-exact"))
    throw new Error(`Video exact alias refused: ${String(result)}`);
});
