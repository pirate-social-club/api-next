import { Data } from "effect";

type MediaSubmissionRepositoryOperation =
  | "reserve"
  | "create"
  | "replay"
  | "get"
  | "list"
  | "terms"
  | "lyrics"
  | "begin-finalize"
  | "finalize"
  | "analysis"
  | "decision"
  | "reference"
  | "review"
  | "moderation"
  | "publish"
  | "retry"
  | "alignment"
  | "attempt"
  | "failure"
  | "workflow"
  | "abandon"
  | "stems";
type MediaSubmissionRepositoryReason =
  | "invalid-input"
  | "not-found"
  | "membership-required"
  | "idempotency-conflict"
  | "stale-revision"
  | "reservation-conflict"
  | "immutable-object-conflict"
  | "transition-rejected"
  | "constraint"
  | "invalid-row"
  | "stale-fence"
  | "post-ownership"
  | "closed-payload";
export class MediaSubmissionRepositoryError extends Data.TaggedError(
  "MediaSubmissionRepositoryError",
)<{
  readonly operation: MediaSubmissionRepositoryOperation;
  readonly reason: MediaSubmissionRepositoryReason;
  readonly submissionId?: string;
  readonly reservationId?: string;
}> {}
