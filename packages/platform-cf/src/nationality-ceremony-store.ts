import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import { Data, Effect } from "effect";
import {
  type DocumentCeremonyAction,
  DocumentCeremonyDataInvalid,
  type DocumentCeremonyRequirement,
  resolveOrIssueDocumentCeremony,
} from "./document-ceremony-store.ts";

export class NationalityCeremonyDataInvalid extends Data.TaggedError(
  "NationalityCeremonyDataInvalid",
) {}
export type NationalityCeremonyAction = DocumentCeremonyAction;
export type NationalityCeremonyRequirement = Omit<DocumentCeremonyRequirement, "actionKind"> &
  Readonly<{
    actionKind: "community_join" | "handle_claim" | "community_creation";
  }>;

/** Preserve the nationality namespace, reservation preimage and error contract. */
export const resolveOrIssueNationalityCeremony = Effect.fn("resolveOrIssueNationalityCeremony")(
  function* (
    transaction: ControlPlaneTransaction,
    input: NationalityCeremonyRequirement,
    options: Readonly<{ readonly nextCeremonyIntentId?: () => string }> = {},
  ): Effect.fn.Return<
    NationalityCeremonyAction,
    ControlPlaneError | NationalityCeremonyDataInvalid
  > {
    return yield* resolveOrIssueDocumentCeremony(transaction, input, {
      ...options,
      namespace: "nationality",
    }).pipe(
      Effect.mapError((error) =>
        error instanceof DocumentCeremonyDataInvalid ? new NationalityCeremonyDataInvalid() : error,
      ),
    );
  },
);
