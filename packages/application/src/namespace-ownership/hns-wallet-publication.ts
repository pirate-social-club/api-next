import type {
  HnsWalletPublicationAttemptV1,
  HnsWalletPublicationCommandV1,
  HnsWalletPublicationResultV1,
} from "@pirate/contracts";
import { Data, type Effect } from "effect";

export class HnsWalletPublicationRejected extends Data.TaggedError("HnsWalletPublicationRejected")<{
  readonly reason: "not_found" | "stale" | "publication_unresolved" | "invalid_command";
}> {}

export interface HnsWalletPublicationStore {
  readonly read: (
    input: HnsWalletPublicationIdentity,
  ) => Effect.Effect<{ readonly attempt: HnsWalletPublicationAttemptV1 | null }, unknown>;
  readonly command: (
    input: HnsWalletPublicationIdentity & {
      readonly command: HnsWalletPublicationCommandV1;
    },
  ) => Effect.Effect<HnsWalletPublicationResultV1, unknown>;
}

interface HnsWalletPublicationIdentity {
  readonly actor_id: string;
  readonly community_id: string;
  readonly root_import_session_id: string;
}
