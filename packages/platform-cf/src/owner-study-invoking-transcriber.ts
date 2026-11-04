// Platform sidecar around the ACTUAL retained ElevenLabs implementation.
// No frozen transcriber change; never records a key/header/body/audio value.

import type { OwnerStudyInvokingTranscriber } from "@pirate/application";
import { Effect } from "effect";
import { makeElevenLabsStudyBatchTranscriber, type StudyBatchFetch } from "./study-spoken-audio.ts";

/** A fetch invocation is not proof that a provider did/did not bill. The
 * existing adapter has no authoritative negative acceptance/cost contract.
 * Every failure after entering actual fetch stays UNKNOWN, including an HTTP
 * error, invalid/oversize response and timeout. Only pre-fetch failure may be
 * not_invoked. Unknown keeps the original call allowance and prevents retry.
 */
export function makeOwnerElevenLabsStudyInvokingTranscriber(
  options: Readonly<{
    apiKey: string;
    fetch?: StudyBatchFetch;
    timeoutMs?: number;
  }>,
): OwnerStudyInvokingTranscriber {
  const fetchImpl = options.fetch ?? fetch;
  const actual = makeElevenLabsStudyBatchTranscriber(options);
  return {
    providerRetention: actual.providerRetention,
    available: options.apiKey.length > 0 && options.apiKey.trim() === options.apiKey,
    invoke: Effect.fn("OwnerElevenLabsStudyInvokingTranscriber.invoke")(function* (
      input: Parameters<OwnerStudyInvokingTranscriber["invoke"]>[0],
    ) {
      // Facts are private to THIS invocation; concurrent requests cannot share
      // mutable dispatch flags or classify each other's unknown call as unused.
      let enteredFetch = false;
      const retained = makeElevenLabsStudyBatchTranscriber({
        ...options,
        fetch: (url, init) => {
          enteredFetch = true;
          return fetchImpl(url, init);
        },
      });
      return yield* retained.transcribe(input).pipe(
        Effect.match({
          onSuccess: (result) => ({ state: "completed" as const, result }),
          onFailure: (error) => ({
            state: "failed" as const,
            reason: error.reason,
            providerDisposition: enteredFetch ? ("unknown" as const) : ("not_invoked" as const),
          }),
        }),
      );
    }),
  };
}
