// INTERNAL failure only. No frozen interface, wire schema or client change.
import { Data } from "effect";
/** Durable writing/unknown may still finish remotely. Keep captured grade and
 * accounting reservation; proof/lease/process loss never implies safe retry.
 * This private upload locator must never enter a public error detail or log.
 */
export class LearnerAudioStorageOutcomeUnknown extends Data.TaggedError(
  "LearnerAudioStorageOutcomeUnknown",
)<{
  readonly uploadAttemptId: string;
}> {}
