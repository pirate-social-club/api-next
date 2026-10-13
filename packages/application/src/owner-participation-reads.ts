import type {GuestParticipationProjectionV1} from '@pirate/contracts';
import type {Effect} from 'effect';
import type {GuestParticipationStoreFailure} from './guest-participation-authority.ts';
/** accountId comes from the current verified ordinary browser principal; no
 * Guest proof/session digest/selected persona is fabricated or persisted. */
export interface OwnerParticipationReadStore {
 readonly list:(input:Readonly<{accountId:string;cursor:string|null;limit:number}>)=>Effect.Effect<Readonly<{
  object:'owner_participation_list_v1';items:readonly GuestParticipationProjectionV1[];next_cursor:string|null;
 }>,GuestParticipationStoreFailure>;
 readonly get:(input:Readonly<{accountId:string;participationId:string}>)=>Effect.Effect<GuestParticipationProjectionV1,GuestParticipationStoreFailure>;
}
