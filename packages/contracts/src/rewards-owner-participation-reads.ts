import {Schema} from 'effect';
import {Auth} from './auth.ts';
import {AuthError,BadRequest,InternalError,NotFound,ProviderUnavailable} from './errors.ts';
import {guestFinancialEndpoint} from './guest-browser-authority.ts';
import {GuestIdentifierV1,GuestParticipationProjectionV1} from './guest-participation.ts';
/** Additive genuine119 account-only source proposal. The frozen projection and
 * existing118 routes remain exact; coordinator admits metadata after native proof. */
export const OwnerParticipationListV1=Schema.Struct({
 object:Schema.Literal('owner_participation_list_v1'),
 items:Schema.Array(GuestParticipationProjectionV1).check(Schema.isMaxLength(100)),
 next_cursor:Schema.NullOr(GuestIdentifierV1),
});
export const ListMyOwnerParticipationsV1=guestFinancialEndpoint({
 method:'GET',path:'/rewards/participations/owner/v1',auth:Auth.user({browserSessionOnly:true}),
 request:{query:Schema.Struct({cursor:Schema.optional(GuestIdentifierV1),limit:Schema.optional(Schema.String.check(Schema.isPattern(/^(?:[1-9]|[1-9][0-9]|100)$/u)))})},
 response:OwnerParticipationListV1,errors:[AuthError,BadRequest,NotFound,InternalError,ProviderUnavailable],
});
export const GetMyOwnerParticipationV1=guestFinancialEndpoint({
 method:'GET',path:'/rewards/participations/:participationId/owner/v1',auth:Auth.user({browserSessionOnly:true}),
 request:{path:Schema.Struct({participationId:GuestIdentifierV1})},response:GuestParticipationProjectionV1,
 errors:[AuthError,BadRequest,NotFound,InternalError,ProviderUnavailable],
});
