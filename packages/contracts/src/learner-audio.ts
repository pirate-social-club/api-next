import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, Conflict, InternalError, ProviderUnavailable } from "./errors.ts";

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));

export const LearnerAudioDeletionResult = Schema.Struct({
  object: Schema.Literal("learner_audio_deletion"),
  deleted_count: Count,
  remaining_count: Count,
  last_deleted_at: Schema.NullOr(Schema.String),
});
export type LearnerAudioDeletionResult = Schema.Schema.Type<typeof LearnerAudioDeletionResult>;

export const DeleteMyLearnerAudio = endpoint({
  method: "DELETE",
  path: "/users/me/learner-audio",
  auth: Auth.userOrAdmin(),
  response: LearnerAudioDeletionResult,
  errors: [AuthError, Conflict, ProviderUnavailable, InternalError],
});
