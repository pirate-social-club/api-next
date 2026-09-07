import { readCompletedStagingReset } from "./staging-persona-phased-reset.ts";

/** The concrete trusted binding between the reset executor and the journal
 * origin: only an execution object that this process actually completed can
 * supply completion evidence. A submitted JSON shape, a matching object
 * literal or a foreign execution refuses inside the executor, so the origin's
 * completion port can never be satisfied by caller-supplied success. The
 * executor's retained marker and execution evidence remain the fuller proof;
 * this binding carries only the schema-validated completion into the signed
 * journal origin. */
export function bindResetCompletionToExecution(execution: object) {
  return async () => (await readCompletedStagingReset(execution)).completion;
}
