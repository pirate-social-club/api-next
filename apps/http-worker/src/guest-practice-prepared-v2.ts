import {
  GuestStudyPreparedContentV1,
  GuestStudyPreparedContentV2,
  InternalError,
} from "@pirate/contracts";
import { Schema } from "effect";
/** Finite egress projection of an ACTUAL118 prepared result, never a substitute
 * query or a financial authority. This cannot erase a nonnull rewarded preview. */
export function projectPracticePreparedGuestStudyContentV2(
  input: unknown,
): GuestStudyPreparedContentV2 {
  const actual = Schema.decodeUnknownSync(GuestStudyPreparedContentV1, {
    onExcessProperty: "error",
  })(input);
  if (actual.reward_preview !== null)
    throw new InternalError({ message: "Practice preview authority differs" });
  return Schema.decodeUnknownSync(GuestStudyPreparedContentV2, { onExcessProperty: "error" })({
    ...actual,
    object: "guest_study_prepared_content_v2",
    reward_preview: null,
    reward_preview_terms_hash: null,
  });
}
