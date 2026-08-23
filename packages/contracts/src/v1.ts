import { Effect, Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  CommentsLocked,
  Conflict,
  GateUnsatisfied,
  IdempotencyConflict,
  InternalError,
  MembershipRequired,
  NotFound,
  PostVoteIdempotencyConflict,
  RateLimited,
  ReplyDepthExceeded,
  UploadObjectMissing,
} from "./errors.ts";
import { TextContentSubmissionV1 } from "./text-moderation.ts";

/**
 * v1 api-next endpoint contracts: session exchange and auth -> profile ->
 * community discovery and membership -> posts, comments, votes -> home feed.
 * Karaoke session, attempt, leaderboard, and WebSocket protocol contracts are
 * part of this slice; capture, scoring runtime, and rewards remain the M4
 * clean-break vertical. Payments, bookings, Telegram, dance, and HNS/EFP are
 * out of this standalone slice. Gates-v2 verification uses its provider-
 * neutral contracts in `verification.ts`.
 *
 * The api-next schemas are the wire source of truth. A few nested fields
 * remain JSON-valued because their complete api-next shapes are not yet
 * frozen; those fields are called out in the endpoint audit and are not
 * silently treated as typed application shapes.
 */

/**
 * Untyped fields are deliberately bounded to these not-yet-ported shapes:
 * media descriptors; linked-handle metadata; community donation partners and
 * reference links; recursive gate-expression children and gate evaluation;
 * post qualifiers, link enrichment, embeds, creator relation, promotion
 * disclosure, event, crosspost source, asset story; localized post gate,
 * market, label, song, study, karaoke, streak, derivative, and translation
 * components; and create-post listing/royalty metadata. They are JSON-valued
 * until their api-next schemas are explicitly typed; no whole request or
 * response is represented as Schema.Unknown.
 */
const JsonValue = Schema.Json;
const JsonObject = Schema.Record(Schema.String, Schema.Json);

const VerificationProviderId = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 128 &&
    value === value.trim() &&
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)
      ? undefined
      : "Expected a canonical verification provider identifier",
  ),
);

const PathCommunity = Schema.Struct({ communityId: Schema.String });
const PathPublicCommunity = Schema.Struct({ communityRef: Schema.String });
const PathPost = Schema.Struct({ postId: Schema.String });
const PathComment = Schema.Struct({ commentId: Schema.String });
const PathMediaSubmission = Schema.Struct({ submissionId: Schema.String });

const LocaleQuery = Schema.Struct({
  locale: Schema.optional(Schema.String),
});

const FeedQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  locale: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.Literals(["best", "top", "new"])),
  time_range: Schema.optional(Schema.Literals(["hour", "day", "week", "month", "year", "all"])),
});

// Public community threads deliberately has a closed phase-1 query surface.
// In particular, callers must opt into the only supported surface and sort;
// the home-feed's best/top/time-range vocabulary is not accepted here.
const PublicCommunityThreadsQuery = Schema.Struct({
  surface: Schema.Literal("threads"),
  sort: Schema.Literal("new"),
  cursor: Schema.optional(Schema.String),
  locale: Schema.optional(Schema.String),
});

const AuthProof = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("privy_access_token"),
    privy_access_token: Schema.String,
    privy_identity_token: Schema.optional(Schema.NullOr(Schema.String)),
    wallet_address: Schema.optional(Schema.NullOr(Schema.String)),
  }),
]);

const VerificationCapabilityState = Schema.Struct({
  state: Schema.Literals(["unverified", "pending", "verified", "expired"]),
  provider: Schema.optional(Schema.NullOr(Schema.Literals(["self", "zkpassport", "very"]))),
  proof_type: Schema.optional(Schema.NullOr(Schema.Literal("unique_human"))),
  mechanism: Schema.optional(Schema.NullOr(Schema.String)),
  verified_at: Schema.optional(Schema.NullOr(Schema.Number)),
});

const VerifiedCapabilityState = Schema.Struct({
  state: Schema.Literals(["unverified", "verified", "expired"]),
  provider: Schema.optional(Schema.NullOr(Schema.Literals(["self", "zkpassport"]))),
  proof_type: Schema.optional(
    Schema.NullOr(Schema.Literals(["age_over_18", "minimum_age", "nationality", "gender"])),
  ),
  mechanism: Schema.optional(Schema.NullOr(Schema.String)),
  verified_at: Schema.optional(Schema.NullOr(Schema.Number)),
});

const WalletScoreCapabilityState = Schema.Struct({
  state: Schema.Literals(["unverified", "verified", "expired"]),
  provider: Schema.optional(Schema.NullOr(Schema.Literal("passport"))),
  proof_type: Schema.optional(Schema.NullOr(Schema.Literal("wallet_score"))),
  mechanism: Schema.optional(Schema.NullOr(Schema.Literal("stamps-api-v2"))),
  verified_at: Schema.optional(Schema.NullOr(Schema.Number)),
  score_decimal: Schema.optional(Schema.NullOr(Schema.String)),
  score_threshold_decimal: Schema.optional(Schema.NullOr(Schema.String)),
  passing_score: Schema.optional(Schema.NullOr(Schema.Boolean)),
  last_scored_at: Schema.optional(Schema.NullOr(Schema.Number)),
  expires_at: Schema.optional(Schema.NullOr(Schema.Number)),
  stamps: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          stamp_name: Schema.optional(Schema.String),
          stamp_score_decimal: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
});

const VerificationCapabilities = Schema.Struct({
  unique_human: VerificationCapabilityState,
  age_over_18: Schema.Struct({
    ...VerifiedCapabilityState.fields,
    proof_type: Schema.optional(Schema.NullOr(Schema.Literal("age_over_18"))),
  }),
  minimum_age: Schema.Struct({
    ...VerifiedCapabilityState.fields,
    proof_type: Schema.optional(Schema.NullOr(Schema.Literal("minimum_age"))),
    value: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
  nationality: Schema.Struct({
    ...VerifiedCapabilityState.fields,
    proof_type: Schema.optional(Schema.NullOr(Schema.Literal("nationality"))),
    value: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  gender: Schema.Struct({
    ...VerifiedCapabilityState.fields,
    proof_type: Schema.optional(Schema.NullOr(Schema.Literal("gender"))),
    value: Schema.optional(Schema.NullOr(Schema.Literals(["M", "F"]))),
  }),
  wallet_score: WalletScoreCapabilityState,
});

const LinkedHandle = Schema.Struct({
  linked_handle: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["pirate", "ens"]),
  verification_state: Schema.Literals(["verified", "unverified", "stale"]),
  metadata: Schema.optional(Schema.NullOr(JsonObject)),
});

const GlobalHandle = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("global_handle"),
  label: Schema.String,
  tier: Schema.Literals(["generated", "standard", "premium"]),
  status: Schema.Literals(["active", "redirect", "retired"]),
  issuance_source: Schema.Literals([
    "generated_signup",
    "free_cleanup_rename",
    "reddit_verified_claim",
    "paid_upgrade",
    "admin_grant",
  ]),
  redirect_target_global_handle: Schema.optional(Schema.NullOr(Schema.String)),
  price_paid_cents: Schema.optional(Schema.NullOr(Schema.Number)),
  free_rename_consumed: Schema.optional(Schema.Boolean),
  issued_at: Schema.Number,
  replaced_at: Schema.optional(Schema.NullOr(Schema.Number)),
});

/** Wire user shape for the api-next identity boundary. */
const User = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("user"),
  primary_wallet_attachment: Schema.optional(Schema.NullOr(Schema.String)),
  verification_state: Schema.Literals([
    "unverified",
    "pending",
    "verified",
    "reverification_required",
  ]),
  capability_provider: Schema.optional(
    Schema.NullOr(Schema.Literals(["self", "zkpassport", "very"])),
  ),
  verification_capabilities: VerificationCapabilities,
  verified_at: Schema.optional(Schema.NullOr(Schema.Number)),
  created: Schema.Number,
});

/** Wire profile shape from the old generated OpenAPI Profile component. */
const Profile = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("profile"),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_ref: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_source: Schema.optional(Schema.NullOr(Schema.Literals(["ens", "upload", "none"]))),
  cover_ref: Schema.optional(Schema.NullOr(Schema.String)),
  cover_source: Schema.optional(Schema.NullOr(Schema.Literals(["ens", "upload", "none"]))),
  bio: Schema.optional(Schema.NullOr(Schema.String)),
  bio_source: Schema.optional(Schema.NullOr(Schema.Literals(["ens", "manual", "none"]))),
  preferred_locale: Schema.optional(Schema.NullOr(Schema.String)),
  explicit_content_preference: Schema.optional(Schema.Literals(["show", "hide"])),
  display_verified_nationality_badge: Schema.optional(Schema.NullOr(Schema.Boolean)),
  nationality_badge_country: Schema.optional(Schema.NullOr(Schema.String)),
  linked_handles: Schema.optional(Schema.NullOr(Schema.Array(LinkedHandle))),
  primary_public_handle: Schema.optional(Schema.NullOr(LinkedHandle)),
  primary_wallet_address: Schema.optional(Schema.NullOr(Schema.String)),
  is_bookable: Schema.optional(Schema.Boolean),
  xmtp_inbox: Schema.optional(Schema.NullOr(Schema.String)),
  verification_capabilities: Schema.optional(Schema.NullOr(VerificationCapabilities)),
  global_handle: GlobalHandle,
  created: Schema.Number,
});

// Public-by-handle deliberately has its own narrow response. It is not an
// alias for Profile: wallet, XMTP, booking, trust, verification, activity,
// follow, media, and count fields must not cross this public boundary.
const PublicGlobalHandle = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("global_handle"),
  label: Schema.String,
  status: Schema.Literals(["active", "redirect", "retired"]),
});

const PublicProfileByHandle = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("profile"),
  display_name: Schema.NullOr(Schema.String),
  avatar_ref: Schema.NullOr(Schema.String),
  avatar_source: Schema.NullOr(Schema.Literals(["ens", "upload", "none"])),
  cover_ref: Schema.NullOr(Schema.String),
  cover_source: Schema.NullOr(Schema.Literals(["ens", "upload", "none"])),
  bio: Schema.NullOr(Schema.String),
  bio_source: Schema.NullOr(Schema.Literals(["ens", "manual", "none"])),
  preferred_locale: Schema.NullOr(Schema.String),
  global_handle: PublicGlobalHandle,
  created: Schema.Number,
});

const CreatedPublicCommunity = Schema.Struct({
  community: Schema.String,
  display_name: Schema.String,
  created: Schema.Number,
  // Route slugs are not persisted in api-next yet; do not manufacture one.
  route_slug: Schema.NullOr(Schema.String),
});

const PublicProfileByHandleResponse = Schema.Struct({
  profile: PublicProfileByHandle,
  requested_handle_label: Schema.String,
  resolved_handle_label: Schema.String,
  is_canonical: Schema.Boolean,
  created_communities: Schema.Array(CreatedPublicCommunity),
});

const WalletAttachment = Schema.Struct({
  wallet_attachment: Schema.String,
  chain_namespace: Schema.String,
  wallet_address: Schema.String,
  is_primary: Schema.Boolean,
});

const Onboarding = Schema.Struct({
  generated_handle_assigned: Schema.Boolean,
  cleanup_rename_available: Schema.Boolean,
  onboarding_dismissed_at: Schema.optional(Schema.NullOr(Schema.Number)),
  unique_human_verification_status: Schema.Literals([
    "not_started",
    "pending",
    "verified",
    "expired",
    "failed",
  ]),
  namespace_verification_status: Schema.Literals([
    "not_started",
    "pending",
    "verified",
    "stale",
    "expired",
    "disputed",
    "failed",
  ]),
  community_creation_ready: Schema.Boolean,
  missing_requirements: Schema.Array(Schema.String),
  reddit_verification_status: Schema.Literals(["not_started", "pending", "verified", "failed"]),
  reddit_import_status: Schema.Literals([
    "not_started",
    "queued",
    "running",
    "succeeded",
    "failed",
  ]),
  suggested_community_ids: Schema.optional(Schema.Array(Schema.String)),
});

const SessionExchangeResponse = Schema.Struct({
  user: User,
  profile: Profile,
  onboarding: Onboarding,
  wallet_attachments: Schema.Array(WalletAttachment),
});

const SessionLogoutResponse = Schema.Struct({
  status: Schema.Literal("ok"),
});

const CommunityBranding = Schema.Struct({
  accent_color: Schema.NullOr(Schema.String),
  theme: Schema.Literals(["system", "light", "dark"]),
  header_style: Schema.Literals(["standard", "compact", "immersive"]),
  tagline: Schema.NullOr(Schema.String),
});

const CommunityRoleSummary = Schema.Struct({
  user: Schema.String,
  display_name: Schema.String,
  handle: Schema.String,
  avatar_ref: Schema.optional(Schema.NullOr(Schema.String)),
  nationality_badge_country: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.Literals(["owner", "admin", "moderator"]),
});

const CommunityTextLocalization = Schema.Struct({
  resolved_locale: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      field_key: Schema.String,
      translation_state: Schema.Literals([
        "ready",
        "pending",
        "failed",
        "same_language",
        "policy_blocked",
      ]),
      machine_translated: Schema.Boolean,
      translated_value: Schema.optional(Schema.NullOr(Schema.String)),
      source_hash: Schema.String,
    }),
  ),
});

const MembershipGateSummary = Schema.Struct({
  gate_id: Schema.optional(Schema.NullOr(Schema.String)),
  gate_type: Schema.Literals([
    "human_verification",
    "nationality",
    "gender",
    "unique_human",
    "age_over_18",
    "minimum_age",
    "wallet_score",
    "altcha_pow",
    "erc721_holding",
    "erc721_inventory_match",
    "asset_balance",
  ]),
  accepted_providers: Schema.optional(Schema.NullOr(Schema.Array(VerificationProviderId))),
  required_value: Schema.optional(Schema.NullOr(Schema.String)),
  required_values: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  excluded_values: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  required_minimum_age: Schema.optional(Schema.NullOr(Schema.Number)),
  minimum_score: Schema.optional(Schema.NullOr(Schema.Number)),
  chain_namespace: Schema.optional(Schema.NullOr(Schema.String)),
  contract_address: Schema.optional(Schema.NullOr(Schema.String)),
  inventory_provider: Schema.optional(Schema.NullOr(Schema.Literal("courtyard"))),
  min_quantity: Schema.optional(Schema.NullOr(Schema.Number)),
  asset_filter_label: Schema.optional(Schema.NullOr(Schema.String)),
  asset_category: Schema.optional(Schema.NullOr(Schema.String)),
  asset_id: Schema.optional(Schema.NullOr(Schema.String)),
  min_amount_atomic: Schema.optional(Schema.NullOr(Schema.String)),
  asset_symbol: Schema.optional(Schema.NullOr(Schema.String)),
  asset_decimals: Schema.optional(Schema.NullOr(Schema.Number)),
});

const MembershipGateExpression = Schema.Union([
  Schema.Struct({ op: Schema.Literal("gate"), gate: MembershipGateSummary }),
  Schema.Struct({
    op: Schema.Literals(["and", "or"]),
    children: Schema.Array(JsonObject),
  }),
]);

const CommunityRule = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("community_rule"),
  title: Schema.String,
  body: Schema.String,
  report_reason: Schema.String,
  position: Schema.Number,
  status: Schema.Literals(["active", "archived"]),
});

const CommunityPreview = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("community_preview"),
  namespace_verification: Schema.optional(Schema.NullOr(Schema.String)),
  route_slug: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  localized_text: Schema.optional(Schema.NullOr(CommunityTextLocalization)),
  avatar_ref: Schema.optional(Schema.NullOr(Schema.String)),
  banner_ref: Schema.optional(Schema.NullOr(Schema.String)),
  branding: Schema.optional(CommunityBranding),
  default_surface: Schema.optional(Schema.Literals(["threads", "videos"])),
  video_feed_enabled: Schema.optional(Schema.Boolean),
  store_url: Schema.optional(Schema.NullOr(Schema.String)),
  store_label: Schema.optional(Schema.NullOr(Schema.String)),
  country_code: Schema.optional(Schema.NullOr(Schema.String)),
  membership_mode: Schema.Literals(["open", "request", "gated"]),
  karaoke_enabled: Schema.optional(Schema.Boolean),
  allow_anonymous_identity: Schema.optional(Schema.Boolean),
  anonymous_identity_scope: Schema.optional(
    Schema.NullOr(Schema.Literals(["community_stable", "thread_stable", "post_ephemeral"])),
  ),
  guest_comment_policy: Schema.optional(Schema.Literals(["disallow", "altcha_required"])),
  agent_posting_policy: Schema.optional(
    Schema.Literals(["disallow", "review", "allow_with_disclosure", "allow"]),
  ),
  agent_posting_scope: Schema.optional(Schema.Literals(["replies_only", "top_level_and_replies"])),
  agent_daily_post_cap: Schema.optional(Schema.NullOr(Schema.Number)),
  agent_daily_reply_cap: Schema.optional(Schema.NullOr(Schema.Number)),
  accepted_agent_ownership_providers: Schema.optional(
    Schema.Array(Schema.Literals(["self_agent_id", "clawkey"])),
  ),
  allowed_disclosed_qualifiers: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  allow_qualifiers_on_anonymous_posts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  human_verification_lane: Schema.NullOr(Schema.Literals(["very", "self"])),
  preferred_verification_provider: Schema.optional(
    Schema.NullOr(Schema.Literals(["self", "zkpassport", "very"])),
  ),
  member_count: Schema.optional(Schema.NullOr(Schema.Number)),
  follower_count: Schema.optional(Schema.NullOr(Schema.Number)),
  donation_policy_mode: Schema.optional(
    Schema.NullOr(Schema.Literals(["none", "optional_creator_sidecar"])),
  ),
  donation_partner: Schema.optional(Schema.NullOr(JsonObject)),
  owner: Schema.optional(Schema.NullOr(CommunityRoleSummary)),
  moderators: Schema.Array(CommunityRoleSummary),
  reference_links: Schema.optional(Schema.NullOr(Schema.Array(JsonObject))),
  membership_gate_summaries: Schema.Array(MembershipGateSummary),
  membership_gate_expression: Schema.optional(Schema.NullOr(MembershipGateExpression)),
  gate_match_mode: Schema.optional(Schema.NullOr(Schema.Literals(["all", "any"]))),
  rules: Schema.Array(CommunityRule),
  viewer_membership_status: Schema.optional(
    Schema.NullOr(Schema.Literals(["member", "not_member", "banned"])),
  ),
  viewer_community_role: Schema.optional(
    Schema.NullOr(Schema.Literals(["owner", "admin", "moderator"])),
  ),
  viewer_following: Schema.optional(Schema.NullOr(Schema.Boolean)),
  created: Schema.Number,
});

/**
 * The published Post document is a repository/read-model contract. It is
 * deliberately separate from CreatePost's text-submission response: a text
 * creation command returns the moderation submission snapshot, while reads
 * and feed projections return this document.
 */
const PostDocument = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("post"),
  community: Schema.String,
  author_user: Schema.optional(Schema.NullOr(Schema.String)),
  author_public_handle: Schema.optional(Schema.NullOr(Schema.String)),
  authorship_mode: Schema.Literals(["human_direct", "user_agent"]),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  agent_ownership_record: Schema.optional(Schema.NullOr(Schema.String)),
  identity_mode: Schema.Literals(["public", "anonymous"]),
  anonymous_scope: Schema.optional(Schema.NullOr(Schema.String)),
  anonymous_label: Schema.optional(Schema.NullOr(Schema.String)),
  agent_handle_snapshot: Schema.optional(Schema.NullOr(Schema.String)),
  agent_display_name_snapshot: Schema.optional(Schema.NullOr(Schema.String)),
  agent_owner_handle_snapshot: Schema.optional(Schema.NullOr(Schema.String)),
  agent_ownership_provider_snapshot: Schema.optional(Schema.NullOr(Schema.String)),
  disclosed_qualifiers_json: Schema.optional(Schema.NullOr(Schema.Array(JsonObject))),
  label: Schema.optional(Schema.NullOr(Schema.String)),
  post_type: Schema.Literals(["text", "image", "video", "link", "song", "crosspost", "file"]),
  status: Schema.Literals([
    "draft",
    "processing",
    "published",
    "failed",
    "hidden",
    "removed",
    "deleted",
  ]),
  comments_locked: Schema.optional(Schema.Boolean),
  comments_locked_at: Schema.optional(Schema.NullOr(Schema.Number)),
  comments_locked_by_user: Schema.optional(Schema.NullOr(Schema.String)),
  comments_lock_reason: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.Literals(["public", "members_only"]),
  publish_failure_code: Schema.optional(Schema.NullOr(Schema.String)),
  publish_failure_message: Schema.optional(Schema.NullOr(Schema.String)),
  publish_failure_retryable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  publish_failed_at: Schema.optional(Schema.NullOr(Schema.Number)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  caption: Schema.optional(Schema.NullOr(Schema.String)),
  lyrics: Schema.optional(Schema.NullOr(Schema.String)),
  link_url: Schema.optional(Schema.NullOr(Schema.String)),
  link_og_image_url: Schema.optional(Schema.NullOr(Schema.String)),
  link_og_title: Schema.optional(Schema.NullOr(Schema.String)),
  link_enrichment: Schema.optional(Schema.NullOr(JsonObject)),
  embeds: Schema.optional(Schema.NullOr(Schema.Array(JsonObject))),
  media_refs: Schema.optional(Schema.Array(JsonValue)),
  creator_relation: Schema.optional(Schema.NullOr(JsonObject)),
  promotion_disclosure: Schema.optional(Schema.NullOr(JsonObject)),
  event: Schema.optional(Schema.NullOr(JsonObject)),
  source_language: Schema.optional(Schema.NullOr(Schema.String)),
  source_language_confidence: Schema.optional(Schema.NullOr(Schema.Number)),
  source_language_reliable: Schema.optional(Schema.Boolean),
  source_language_detector: Schema.optional(Schema.NullOr(Schema.String)),
  source_language_detected_at: Schema.optional(Schema.NullOr(Schema.String)),
  source_language_source_hash: Schema.optional(Schema.NullOr(Schema.String)),
  lyrics_language: Schema.optional(Schema.NullOr(Schema.String)),
  lyrics_language_confidence: Schema.optional(Schema.NullOr(Schema.Number)),
  lyrics_language_reliable: Schema.optional(Schema.Boolean),
  lyrics_language_detector: Schema.optional(Schema.NullOr(Schema.String)),
  lyrics_language_detected_at: Schema.optional(Schema.NullOr(Schema.String)),
  lyrics_language_source_hash: Schema.optional(Schema.NullOr(Schema.String)),
  translation_policy: Schema.optional(
    Schema.NullOr(Schema.Literals(["none", "machine_allowed", "human_only", "hybrid"])),
  ),
  access_mode: Schema.optional(Schema.NullOr(Schema.Literals(["public", "locked"]))),
  asset: Schema.optional(Schema.NullOr(Schema.String)),
  song_artifact_bundle: Schema.optional(Schema.NullOr(Schema.String)),
  crosspost_source: Schema.optional(Schema.NullOr(JsonObject)),
  anchor_live_room: Schema.optional(Schema.NullOr(Schema.String)),
  anchor_live_room_status: Schema.optional(
    Schema.NullOr(Schema.Literals(["scheduled", "live", "ended", "canceled"])),
  ),
  song_title: Schema.optional(Schema.NullOr(Schema.String)),
  song_annotations_url: Schema.optional(Schema.NullOr(Schema.String)),
  parent_post: Schema.optional(Schema.NullOr(Schema.String)),
  song_mode: Schema.optional(Schema.NullOr(Schema.Literals(["original", "remix"]))),
  rights_basis: Schema.optional(
    Schema.NullOr(Schema.Literals(["none", "original", "derivative", "attribution_only"])),
  ),
  upstream_asset_refs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  analysis_state: Schema.Literals([
    "pending",
    "allow",
    "allow_with_required_reference",
    "review_required",
    "blocked",
  ]),
  analysis_result_ref: Schema.optional(Schema.NullOr(Schema.String)),
  content_safety_state: Schema.Literals(["pending", "safe", "sensitive", "adult"]),
  age_gate_policy: Schema.Literals(["none", "18_plus"]),
  asset_story: Schema.optional(Schema.NullOr(JsonObject)),
  created: Schema.Number,
});
export type PostDocument = Schema.Schema.Type<typeof PostDocument>;

const LocalizedPost = Schema.Struct({
  post: PostDocument,
  community: Schema.optional(Schema.NullOr(CommunityPreview)),
  viewer_gate_state: Schema.optional(Schema.NullOr(JsonObject)),
  author_community_role: Schema.optional(Schema.NullOr(Schema.String)),
  thread_snapshot: Schema.NullOr(JsonObject),
  market_context: Schema.optional(Schema.NullOr(JsonObject)),
  label: Schema.optional(Schema.NullOr(JsonObject)),
  song_presentation: Schema.optional(Schema.NullOr(JsonObject)),
  study_capability: Schema.optional(Schema.NullOr(JsonObject)),
  karaoke_capability: Schema.optional(Schema.NullOr(JsonObject)),
  streak_summary: Schema.optional(Schema.NullOr(JsonObject)),
  asset_story: Schema.optional(Schema.NullOr(JsonObject)),
  derivative_sources: Schema.optional(Schema.NullOr(Schema.Array(JsonObject))),
  upvote_count: Schema.Number,
  downvote_count: Schema.Number,
  like_count: Schema.Number,
  comment_count: Schema.optional(Schema.Number),
  viewer_vote: Schema.NullOr(Schema.Literals([-1, 1])),
  viewer_is_author: Schema.optional(Schema.Boolean),
  viewer_reaction_kinds: Schema.Array(Schema.Literal("like")),
  age_gate_viewer_state: Schema.optional(Schema.NullOr(Schema.String)),
  resolved_locale: Schema.String,
  translation_state: Schema.Literals([
    "ready",
    "pending",
    "failed",
    "same_language",
    "policy_blocked",
  ]),
  machine_translated: Schema.Boolean,
  translated_body: Schema.optional(Schema.NullOr(Schema.String)),
  translated_title: Schema.optional(Schema.NullOr(Schema.String)),
  translated_caption: Schema.optional(Schema.NullOr(Schema.String)),
  translated_embeds: Schema.optional(Schema.NullOr(Schema.Array(JsonObject))),
  source_hash: Schema.String,
});

const HomeFeedCommunitySummary = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("home_feed_community_summary"),
  display_name: Schema.String,
  route_slug: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_ref: Schema.optional(Schema.NullOr(Schema.String)),
  branding: Schema.optional(CommunityBranding),
  default_surface: Schema.optional(Schema.Literals(["threads", "videos"])),
  video_feed_enabled: Schema.optional(Schema.Boolean),
  member_count: Schema.optional(Schema.NullOr(Schema.Number)),
  follower_count: Schema.optional(Schema.NullOr(Schema.Number)),
  view_count: Schema.optional(Schema.NullOr(Schema.Number)),
});

const FeedBooking = Schema.Struct({
  host_user_id: Schema.String,
  base_price_cents: Schema.Number,
  has_available_slot: Schema.Boolean,
  starting_price_cents: Schema.NullOr(Schema.Number),
  currency: Schema.Literal("USDC"),
});

const HomeFeedItem = Schema.Struct({
  post: LocalizedPost,
  community: HomeFeedCommunitySummary,
  booking: Schema.optional(FeedBooking),
});

const HomeFeedResponse = Schema.Struct({
  items: Schema.Array(HomeFeedItem),
  top_communities: Schema.Array(HomeFeedCommunitySummary),
  next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const PublicCommunityThreadsResponse = Schema.Struct({
  community: CommunityPreview,
  items: Schema.Array(LocalizedPost),
  next_cursor: Schema.NullOr(Schema.String),
});

const CreatePostCommon = {
  idempotency_key: Schema.String,
  authorship_mode: Schema.optional(Schema.Literals(["human_direct", "user_agent"])),
  identity_mode: Schema.optional(Schema.Literals(["public", "anonymous"])),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.optional(Schema.Literals(["public", "members_only"])),
  title: Schema.optional(Schema.NullOr(Schema.String)),
};

const CreatePostRequest = Schema.Struct({ ...CreatePostCommon, post_type: Schema.Literal("text") });

const PositiveSafeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const NonNegativeBasisPoints = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));
const CommercialRevShareBps = NonNegativeBasisPoints.check(
  Schema.makeFilter(() => undefined, { toJsonSchema: () => ({ default: 1000 }) }),
).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1000)));
const PositiveBasisPoints = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }));
const PositiveRevision = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const SongAuthorString = Schema.NonEmptyString;
const RoyaltyAllocations = Schema.Array(
  Schema.Struct({
    recipient_id: SongAuthorString,
    share_bps: PositiveBasisPoints,
  }),
).check(
  Schema.isMinLength(1),
  Schema.makeFilter((allocations) => {
    const recipients = new Set(allocations.map(({ recipient_id }) => recipient_id));
    const total = allocations.reduce((sum, { share_bps }) => sum + share_bps, 0);
    return recipients.size === allocations.length && total === 10_000
      ? undefined
      : "Royalty allocations must contain unique recipients totaling 10000 basis points";
  }),
);

const SongAuthorInputCommon = {
  version: Schema.Literal("song-author-input-v1"),
  title: SongAuthorString,
  lyrics: Schema.NullOr(Schema.String),
  audio_reservation_id: SongAuthorString,
  rights_declaration: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("original") }),
    Schema.Struct({ kind: Schema.Literal("derivative"), upstream_asset_id: SongAuthorString }),
  ]),
  royalty_allocations: RoyaltyAllocations,
  access_mode: Schema.Literal("public"),
};

/** The author-controlled song bundle; trusted analysis never enters this schema. */
export const SongAuthorInputV1 = Schema.Union([
  Schema.Struct({
    ...SongAuthorInputCommon,
    license_preset: Schema.Literals(["non-commercial", "commercial-use"]),
  }),
  Schema.Struct({
    ...SongAuthorInputCommon,
    license_preset: Schema.Literal("commercial-remix"),
    commercial_rev_share_bps: CommercialRevShareBps,
  }),
]);
export type SongAuthorInputV1 = Schema.Schema.Type<typeof SongAuthorInputV1>;

export const ReserveSongAudioV1 = Schema.Struct({
  idempotency_key: SongAuthorString,
  track: Schema.Literal("song"),
  slot: Schema.Literal("primary_audio"),
  expected_content_type: Schema.String.check(
    Schema.isPattern(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u),
  ),
  expected_size_bytes: PositiveSafeInteger,
  expected_sha256: Schema.optional(Sha256Hex),
});
export type ReserveSongAudioV1 = Schema.Schema.Type<typeof ReserveSongAudioV1>;

const RequiredUploadHeader = Schema.Struct({ name: SongAuthorString, value: SongAuthorString });
export const SongAudioReservationV1 = Schema.Struct({
  reservation_id: SongAuthorString,
  track: Schema.Literal("song"),
  slot: Schema.Literal("primary_audio"),
  status: Schema.Literal("awaiting_upload"),
  upload: Schema.Struct({
    method: Schema.Literal("PUT"),
    url: SongAuthorString,
    required_headers: Schema.Array(RequiredUploadHeader),
    expires_at: SongAuthorString,
  }),
});
export type SongAudioReservationV1 = Schema.Schema.Type<typeof SongAudioReservationV1>;

export const CreateSongSubmissionV1 = Schema.Union([
  Schema.Struct({
    ...SongAuthorInputCommon,
    license_preset: Schema.Literals(["non-commercial", "commercial-use"]),
    idempotency_key: SongAuthorString,
  }),
  Schema.Struct({
    ...SongAuthorInputCommon,
    license_preset: Schema.Literal("commercial-remix"),
    commercial_rev_share_bps: CommercialRevShareBps,
    idempotency_key: SongAuthorString,
  }),
]);
export type CreateSongSubmissionV1 = Schema.Schema.Type<typeof CreateSongSubmissionV1>;

export const FinalizeSongUploadV1 = Schema.Struct({
  idempotency_key: SongAuthorString,
  expected_creation_revision: PositiveRevision,
  reservation_id: SongAuthorString,
});
export type FinalizeSongUploadV1 = Schema.Schema.Type<typeof FinalizeSongUploadV1>;

export const BindSongReferenceV1 = Schema.Struct({
  idempotency_key: SongAuthorString,
  expected_creation_revision: PositiveRevision,
  reference_request_ref: SongAuthorString,
  upstream_asset_id: SongAuthorString,
});
export type BindSongReferenceV1 = Schema.Schema.Type<typeof BindSongReferenceV1>;

export const RetryOrCancelSongSubmissionV1 = Schema.Struct({
  idempotency_key: SongAuthorString,
  expected_creation_revision: PositiveRevision,
});
export type RetryOrCancelSongSubmissionV1 = Schema.Schema.Type<
  typeof RetryOrCancelSongSubmissionV1
>;

export const ModerateSongSubmissionV1 = Schema.Union([
  Schema.Struct({
    idempotency_key: SongAuthorString,
    expected_creation_revision: PositiveRevision,
    action: Schema.Literal("approve"),
    approval_kind: Schema.Literal("standard"),
  }),
  Schema.Struct({
    idempotency_key: SongAuthorString,
    expected_creation_revision: PositiveRevision,
    action: Schema.Literal("approve"),
    approval_kind: Schema.Literal("acr_override"),
    evidence_ref: SongAuthorString,
    reason_code: Schema.Literals(["acr_inconclusive", "acr_exhausted", "acr_skipped"]),
  }),
  Schema.Struct({
    idempotency_key: SongAuthorString,
    expected_creation_revision: PositiveRevision,
    action: Schema.Literal("block"),
    evidence_ref: SongAuthorString,
    reason_code: Schema.Literal("policy_violation"),
  }),
]);
export type ModerateSongSubmissionV1 = Schema.Schema.Type<typeof ModerateSongSubmissionV1>;

export const PostProcessingPhase = Schema.Literals([
  "reserve",
  "awaiting_upload",
  "finalize",
  "analysis",
  "decision",
  "publish",
]);

const MediaSubmissionCommon = {
  submission_id: SongAuthorString,
  href: SongAuthorString,
  track: Schema.Literal("song"),
  creation_revision: PositiveRevision,
  updated_at: SongAuthorString,
};
export const MediaPostSubmissionV1 = Schema.Union([
  Schema.Struct({
    ...MediaSubmissionCommon,
    status: Schema.Literal("processing"),
    phase: PostProcessingPhase,
  }),
  Schema.Struct({
    ...MediaSubmissionCommon,
    status: Schema.Literal("action_required"),
    action: Schema.Struct({
      kind: Schema.Literal("reference_required"),
      expires_at: SongAuthorString,
      reference_request_ref: SongAuthorString,
    }),
  }),
  Schema.Struct({
    ...MediaSubmissionCommon,
    status: Schema.Literal("manual_review"),
    reason_code: Schema.Literals(["review_required", "moderation_unavailable"]),
    review_ref: SongAuthorString,
  }),
  Schema.Struct({
    ...MediaSubmissionCommon,
    status: Schema.Literal("published"),
    published_resource: Schema.Struct({ post_id: SongAuthorString, href: SongAuthorString }),
  }),
  Schema.Struct({
    ...MediaSubmissionCommon,
    status: Schema.Literal("blocked"),
    reason_code: Schema.Literal("policy_violation"),
  }),
  Schema.Struct({
    ...MediaSubmissionCommon,
    status: Schema.Literal("processing_failed"),
    reason_code: Schema.Literals([
      "invalid_media",
      "unsupported_media",
      "probe_failed",
      "hash_failed",
      "transform_failed",
      "publication_failed",
      "upload_seal_conflict",
    ]),
    retry_count: Schema.Literals([0, 1, 2, 3]),
    retryable: Schema.Boolean,
  }),
  Schema.Struct({
    ...MediaSubmissionCommon,
    status: Schema.Literal("abandoned"),
    reason_code: Schema.Literals([
      "upload_reservation_expired",
      "upload_expectation_mismatch",
      "upload_source_changed_before_finalize",
      "reference_window_expired",
      "author_cancelled_before_finalize",
    ]),
  }),
]);
export type MediaPostSubmissionV1 = Schema.Schema.Type<typeof MediaPostSubmissionV1>;

export const SealUploadResultV1 = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("sealed"),
    immutable_ref: SongAuthorString,
    etag: SongAuthorString,
    version: SongAuthorString,
    size_bytes: PositiveSafeInteger,
  }),
  Schema.Struct({ outcome: Schema.Literal("source_missing") }),
  Schema.Struct({ outcome: Schema.Literal("source_precondition_failed") }),
  Schema.Struct({ outcome: Schema.Literal("expectation_mismatch") }),
  Schema.Struct({ outcome: Schema.Literal("destination_conflict") }),
]);
export type SealUploadResultV1 = Schema.Schema.Type<typeof SealUploadResultV1>;

export const SongTrustedAnalysisV1 = Schema.Struct({
  version: Schema.Literal("song-trusted-analysis-v1"),
  operation_id: SongAuthorString,
  creation_revision: PositiveRevision,
  finalized_audio_ref: SongAuthorString,
  canonical_audio_sha256: Sha256Hex,
  probe_evidence_ref: SongAuthorString,
  acr: Schema.Struct({
    decision: Schema.Literals(["allow", "requires_reference", "inconclusive", "skipped"]),
    evidence_ref: SongAuthorString,
    policy_revision: SongAuthorString,
    adapter_revision: SongAuthorString,
  }),
  lyrics_safety: Schema.Literals(["skipped", "allow", "review_required", "blocked"]),
  media_safety: Schema.Literals(["allow", "draft", "review_required", "blocked"]),
  bound_reference: Schema.NullOr(
    Schema.Struct({
      asset_id: SongAuthorString,
      evidence_creation_revision: PositiveRevision,
      upstream_commercial_rev_share_bps: Schema.NullOr(NonNegativeBasisPoints),
    }),
  ),
});
export type SongTrustedAnalysisV1 = Schema.Schema.Type<typeof SongTrustedAnalysisV1>;

export const SongPublishedProjectionV1 = Schema.Struct({
  version: Schema.Literal("song-published-projection-v1"),
  submission_id: SongAuthorString,
  post_id: SongAuthorString,
  creation_revision: PositiveRevision,
  audio_asset_ref: SongAuthorString,
  analysis_badges: Schema.Union([
    Schema.Tuple([]),
    Schema.Tuple([Schema.Literal("reference_bound")]),
  ]),
  language_detection: Schema.Literals(["pending", "ready", "unavailable"]),
  alignment: Schema.Literals(["pending", "ready", "unavailable"]),
  data_registration: Schema.Literals(["pending", "registered", "failed"]),
  locked_delivery: Schema.Literals(["not_required", "preparing", "ready", "failed"]),
});
export type SongPublishedProjectionV1 = Schema.Schema.Type<typeof SongPublishedProjectionV1>;

const TextCommentReplyRequestV1 = Schema.Struct({
  idempotency_key: Schema.String,
  body: Schema.String,
});

const CommentReportReasonCode = Schema.Literals([
  "spam",
  "harassment",
  "hate",
  "sexual_content",
  "graphic_content",
  "misleading",
  "other",
]);

const CommentReportRequestV1 = Schema.Struct({
  idempotency_key: Schema.String,
  reason_code: CommentReportReasonCode,
});

const CommentReportResponseV1 = Schema.Struct({
  report_id: Schema.String,
  case_ref: Schema.String,
  status: Schema.Literals(["open", "coalesced"]),
});

const TextModerationAction = Schema.Literals(["approve", "dismiss", "hide", "remove", "restore"]);

const ModerationCaseActionRequestV1 = Schema.Struct({
  idempotency_key: Schema.String,
  action: TextModerationAction,
});

const ModerationCaseActionResponseV1 = Schema.Struct({
  action_id: Schema.String,
  case_ref: Schema.String,
  action: TextModerationAction,
  target_status: Schema.Literals(["held", "published", "hidden", "removed"]),
});

const Jwk = Schema.Struct({
  kty: Schema.String,
  n: Schema.String,
  e: Schema.String,
  alg: Schema.Literal("RS256"),
  use: Schema.Literal("sig"),
  key_ops: Schema.Array(Schema.Literal("verify")),
  kid: Schema.String,
});

const Jwks = Schema.Struct({ keys: Schema.Array(Jwk) });

// --- session exchange and auth -------------------------------------------

export const SessionExchange = endpoint({
  method: "POST",
  path: "/auth/session/exchange",
  auth: Auth.public(),
  request: { body: Schema.Struct({ proof: AuthProof }) },
  response: SessionExchangeResponse,
  successStatus: 200,
  errors: [AuthError, BadRequest, InternalError, RateLimited],
});

/** Public account-provisioning proof boundary; no identity metadata is accepted. */
export const RegisterIdentity = endpoint({
  method: "POST",
  path: "/auth/register",
  auth: Auth.public(),
  request: { body: Schema.Struct({ privy_access_token: Schema.String }) },
  response: SessionExchangeResponse,
  successStatus: 201,
  errors: [AuthError, BadRequest, RateLimited, Conflict, InternalError],
});

/** Same-origin browser logout; the transport clears the exact cookie tuple. */
export const SessionLogout = endpoint({
  method: "POST",
  path: "/auth/session/logout",
  auth: Auth.public(),
  response: SessionLogoutResponse,
  successStatus: 200,
  errors: [AuthError, BadRequest],
});

export const GetCurrentUser = endpoint({
  method: "GET",
  path: "/users/me",
  auth: Auth.user(),
  response: User,
  successStatus: 200,
  errors: [AuthError],
});

export const GetMyProfile = endpoint({
  method: "GET",
  path: "/profiles/me",
  auth: Auth.userOrAdmin(),
  response: Profile,
  successStatus: 200,
  errors: [AuthError],
});

export const GetPublicProfileByHandle = endpoint({
  method: "GET",
  path: "/public-profiles/:handle",
  auth: Auth.public(),
  request: { path: Schema.Struct({ handle: Schema.String }) },
  response: PublicProfileByHandleResponse,
  successStatus: 200,
  errors: [BadRequest, NotFound, InternalError],
});

// --- community discovery and membership ----------------------------------

export const GetCommunityPreview = endpoint({
  method: "GET",
  path: "/communities/:communityId/preview",
  auth: Auth.userOrAdmin({ optionalUser: true }),
  request: { path: PathCommunity, query: LocaleQuery },
  response: CommunityPreview,
  successStatus: 200,
  errors: [AuthError, BadRequest, NotFound],
});

const JoinNextActionWaitReasonCode = Schema.Literals([
  "verification_pending",
  "membership_pending",
  "operation_pending",
  "reconciliation_pending",
]);

const JoinNextAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start_verification"),
    provider_id: VerificationProviderId,
    intent_id: Schema.NonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("join") }),
  Schema.Struct({ kind: Schema.Literal("request_membership") }),
  Schema.Struct({
    kind: Schema.Literal("wait"),
    reason_code: JoinNextActionWaitReasonCode,
    retry_after_seconds: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("blocked"),
    reason: Schema.Literals(["banned", "gate_failed", "unsupported"]),
  }),
  Schema.Struct({ kind: Schema.Literal("none"), reason: Schema.Literal("already_joined") }),
]);

const JoinEligibility = Schema.Struct({
  community: Schema.String,
  membership_mode: Schema.Literals(["open", "request", "gated"]),
  human_verification_lane: Schema.NullOr(Schema.Literals(["very", "self"])),
  preferred_verification_provider: Schema.optional(Schema.NullOr(VerificationProviderId)),
  joinable_now: Schema.Boolean,
  status: Schema.Literals([
    "joinable",
    "requestable",
    "pending_request",
    "verification_required",
    "gate_failed",
    "already_joined",
    "banned",
  ]),
  membership_gate_summaries: Schema.Array(MembershipGateSummary),
  membership_gate_expression: Schema.optional(Schema.NullOr(MembershipGateExpression)),
  missing_capabilities: Schema.optional(
    Schema.Array(
      Schema.Literals([
        "unique_human",
        "human_verification",
        "age_over_18",
        "minimum_age",
        "nationality",
        "gender",
        "wallet_score",
        "altcha_pow",
      ]),
    ),
  ),
  suggested_verification_provider: Schema.optional(Schema.NullOr(VerificationProviderId)),
  suggested_verification_intent: Schema.optional(
    Schema.NullOr(Schema.Literals(["community_join", "post_create", "comment_create"])),
  ),
  failure_reason: Schema.optional(
    Schema.NullOr(
      Schema.Literals([
        "missing_verification",
        "provider_not_accepted",
        "nationality_mismatch",
        "gender_mismatch",
        "minimum_age_mismatch",
        "erc721_holding_required",
        "erc721_inventory_match_required",
        "token_inventory_unavailable",
        "wallet_score_too_low",
        "asset_balance_too_low",
        "unsupported",
        "banned",
      ]),
    ),
  ),
  wallet_score_status: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        current_score_decimal: Schema.optional(Schema.NullOr(Schema.String)),
        required_score_decimal: Schema.optional(Schema.NullOr(Schema.String)),
        passing_score: Schema.optional(Schema.NullOr(Schema.Boolean)),
        last_scored_at: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
  // GatePolicyEvaluation remains explicitly JSON-valued until its api-next
  // envelope is frozen; this is a bounded schema gap, not an open request.
  gate_evaluation: Schema.optional(Schema.NullOr(JsonObject)),
  next_action: JoinNextAction,
});

export const GetJoinEligibility = endpoint({
  method: "GET",
  path: "/communities/:communityId/join-eligibility",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity },
  response: JoinEligibility,
  successStatus: 200,
  errors: [AuthError, NotFound, InternalError],
});

export const JoinCommunity = endpoint({
  method: "POST",
  path: "/communities/:communityId/join",
  auth: Auth.userOrAdmin(),
  request: {
    path: PathCommunity,
    body: Schema.Struct({ note: Schema.optional(Schema.NullOr(Schema.String)) }),
    bodyRequired: false,
  },
  response: Schema.Struct({
    community: Schema.String,
    status: Schema.Literals(["joined", "requested", "left"]),
  }),
  successStatus: 200,
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    GateUnsatisfied,
    MembershipRequired,
    NotFound,
    RateLimited,
  ],
});

export const FollowCommunity = endpoint({
  method: "POST",
  path: "/communities/:communityId/follow",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity, body: Schema.Struct({}), bodyRequired: false },
  response: Schema.Struct({
    community: Schema.String,
    following: Schema.Boolean,
    follower_count: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
  successStatus: 200,
  errors: [AuthError, MembershipRequired, NotFound, RateLimited],
});

export const UnfollowCommunity = endpoint({
  method: "POST",
  path: "/communities/:communityId/unfollow",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity, body: Schema.Struct({}), bodyRequired: false },
  response: Schema.Struct({
    community: Schema.String,
    following: Schema.Boolean,
    follower_count: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
  successStatus: 200,
  errors: [AuthError, Conflict, NotFound, RateLimited],
});

// --- posts, comments, votes ----------------------------------------------

export const CreatePost = endpoint({
  method: "POST",
  path: "/communities/:communityId/posts",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity, body: CreatePostRequest },
  response: TextContentSubmissionV1,
  successStatus: 201,
  errors: [AuthError, BadRequest, IdempotencyConflict, MembershipRequired, NotFound, RateLimited],
});

// --- song media R0 --------------------------------------------------------

export const CreateMediaUploadReservation = endpoint({
  method: "POST",
  path: "/communities/:communityId/media-upload-reservations",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity, body: ReserveSongAudioV1 },
  response: SongAudioReservationV1,
  successStatus: 201,
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    IdempotencyConflict,
    MembershipRequired,
    NotFound,
    RateLimited,
  ],
});

export const CreateMediaPostSubmission = endpoint({
  method: "POST",
  path: "/communities/:communityId/media-post-submissions",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity, body: CreateSongSubmissionV1 },
  response: MediaPostSubmissionV1,
  successStatus: 201,
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    IdempotencyConflict,
    MembershipRequired,
    NotFound,
    RateLimited,
  ],
});

export const FinalizeMediaPostSubmission = endpoint({
  method: "POST",
  path: "/media-post-submissions/:submissionId/finalize",
  auth: Auth.userOrAdmin(),
  request: { path: PathMediaSubmission, body: FinalizeSongUploadV1 },
  response: MediaPostSubmissionV1,
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    IdempotencyConflict,
    UploadObjectMissing,
    NotFound,
    RateLimited,
  ],
});

export const GetMediaPostSubmission = endpoint({
  method: "GET",
  path: "/media-post-submissions/:submissionId",
  auth: Auth.userOrAdmin(),
  request: { path: PathMediaSubmission },
  response: MediaPostSubmissionV1,
  errors: [AuthError, NotFound, InternalError],
});

export const BindMediaPostSubmissionReference = endpoint({
  method: "POST",
  path: "/media-post-submissions/:submissionId/reference",
  auth: Auth.userOrAdmin(),
  request: { path: PathMediaSubmission, body: BindSongReferenceV1 },
  response: MediaPostSubmissionV1,
  errors: [AuthError, BadRequest, Conflict, IdempotencyConflict, NotFound, RateLimited],
});

export const RetryMediaPostSubmission = endpoint({
  method: "POST",
  path: "/media-post-submissions/:submissionId/retry",
  auth: Auth.userOrAdmin(),
  request: { path: PathMediaSubmission, body: RetryOrCancelSongSubmissionV1 },
  response: MediaPostSubmissionV1,
  errors: [AuthError, BadRequest, Conflict, IdempotencyConflict, NotFound, RateLimited],
});

export const CancelMediaPostSubmission = endpoint({
  method: "POST",
  path: "/media-post-submissions/:submissionId/cancel",
  auth: Auth.userOrAdmin(),
  request: { path: PathMediaSubmission, body: RetryOrCancelSongSubmissionV1 },
  response: MediaPostSubmissionV1,
  errors: [AuthError, BadRequest, Conflict, IdempotencyConflict, NotFound, RateLimited],
});

export const ModerateMediaPostSubmission = endpoint({
  method: "POST",
  path: "/moderation/media-post-submissions/:submissionId/actions",
  auth: Auth.admin("moderation"),
  request: { path: PathMediaSubmission, body: ModerateSongSubmissionV1 },
  response: MediaPostSubmissionV1,
  errors: [AuthError, BadRequest, Conflict, IdempotencyConflict, NotFound, RateLimited],
});

export const GetTextContentSubmission = endpoint({
  method: "GET",
  path: "/text-content-submissions/:submissionId",
  auth: Auth.userOrAdmin(),
  request: { path: Schema.Struct({ submissionId: Schema.String }) },
  response: TextContentSubmissionV1,
  successStatus: 200,
  errors: [AuthError, NotFound, InternalError],
});

export const GetPost = endpoint({
  method: "GET",
  path: "/posts/:postId",
  auth: Auth.userOrAdmin(),
  request: { path: PathPost, query: LocaleQuery },
  response: LocalizedPost,
  successStatus: 200,
  errors: [AuthError, BadRequest, NotFound],
});

export const CreateComment = endpoint({
  method: "POST",
  path: "/posts/:postId/comments",
  auth: Auth.userOrAdmin(),
  request: { path: PathPost, body: TextCommentReplyRequestV1 },
  response: TextContentSubmissionV1,
  successStatus: 201,
  errors: [
    AuthError,
    BadRequest,
    CommentsLocked,
    Conflict,
    GateUnsatisfied,
    IdempotencyConflict,
    MembershipRequired,
    NotFound,
    RateLimited,
  ],
});

const VoteRequest = Schema.Struct({
  idempotency_key: Schema.String,
  value: Schema.Literals([-1, 1]),
});
const VoteResponse = Schema.Struct({
  post_id: Schema.String,
  value: Schema.Literals([-1, 1]),
});
const ClearVoteResponse = Schema.Struct({
  post_id: Schema.String,
  value: Schema.Literal(0),
});

export const CastPostVote = endpoint({
  method: "POST",
  path: "/posts/:postId/vote",
  auth: Auth.userOrAdmin(),
  request: { path: PathPost, body: VoteRequest },
  response: VoteResponse,
  successStatus: 200,
  errors: [
    AuthError,
    BadRequest,
    PostVoteIdempotencyConflict,
    MembershipRequired,
    NotFound,
    RateLimited,
  ],
});

export const ClearPostVote = endpoint({
  method: "POST",
  path: "/posts/:postId/clear_vote",
  auth: Auth.userOrAdmin(),
  request: {
    path: PathPost,
    body: Schema.Struct({ idempotency_key: Schema.String }),
  },
  response: ClearVoteResponse,
  successStatus: 200,
  errors: [
    AuthError,
    BadRequest,
    PostVoteIdempotencyConflict,
    MembershipRequired,
    NotFound,
    RateLimited,
  ],
});

export const CreateCommentReply = endpoint({
  method: "POST",
  path: "/comments/:commentId/replies",
  auth: Auth.userOrAdmin(),
  request: { path: PathComment, body: TextCommentReplyRequestV1 },
  response: TextContentSubmissionV1,
  successStatus: 201,
  errors: [
    AuthError,
    BadRequest,
    CommentsLocked,
    Conflict,
    GateUnsatisfied,
    IdempotencyConflict,
    MembershipRequired,
    NotFound,
    RateLimited,
    ReplyDepthExceeded,
  ],
});

export const ReportComment = endpoint({
  method: "POST",
  path: "/comments/:commentId/reports",
  auth: Auth.userOrAdmin(),
  request: { path: PathComment, body: CommentReportRequestV1 },
  response: CommentReportResponseV1,
  successStatus: 201,
  errors: [AuthError, BadRequest, IdempotencyConflict, MembershipRequired, NotFound, RateLimited],
});

export const ModerateCaseAction = endpoint({
  method: "POST",
  path: "/moderation/cases/:caseRef/actions",
  auth: Auth.userOrAdmin(),
  request: {
    path: Schema.Struct({ caseRef: Schema.String }),
    body: ModerationCaseActionRequestV1,
  },
  response: ModerationCaseActionResponseV1,
  successStatus: 200,
  errors: [
    AuthError,
    BadRequest,
    CommentsLocked,
    Conflict,
    IdempotencyConflict,
    NotFound,
    RateLimited,
    ReplyDepthExceeded,
  ],
});

// --- home feed -------------------------------------------------------------

export const GetPublicHomeFeed = endpoint({
  method: "GET",
  path: "/feed/home/public",
  auth: Auth.public(),
  request: { query: FeedQuery },
  response: HomeFeedResponse,
  successStatus: 200,
  errors: [BadRequest, RateLimited],
});

export const GetPublicCommunityThreads = endpoint({
  method: "GET",
  path: "/public-communities/:communityRef/feed",
  auth: Auth.public(),
  request: {
    path: PathPublicCommunity,
    exactRawPathParameters: ["communityRef"],
    query: PublicCommunityThreadsQuery,
  },
  response: PublicCommunityThreadsResponse,
  successStatus: 200,
  errors: [BadRequest, InternalError, NotFound],
});

export const GetHomeFeed = endpoint({
  method: "GET",
  path: "/feed/home",
  auth: Auth.user({ optionalUser: true }),
  request: { query: FeedQuery },
  response: HomeFeedResponse,
  successStatus: 200,
  errors: [AuthError, BadRequest, RateLimited],
});

export const GetJwks = endpoint({
  method: "GET",
  path: "/.well-known/jwks.json",
  auth: Auth.public(),
  response: Jwks,
  successStatus: 200,
});

/** Endpoint-only registry boundary; schema exports above must not enter it. */
export const v1Registry = {
  SessionExchange,
  RegisterIdentity,
  SessionLogout,
  GetCurrentUser,
  GetMyProfile,
  GetPublicProfileByHandle,
  GetCommunityPreview,
  GetJoinEligibility,
  JoinCommunity,
  FollowCommunity,
  UnfollowCommunity,
  CreatePost,
  CreateMediaUploadReservation,
  CreateMediaPostSubmission,
  FinalizeMediaPostSubmission,
  GetMediaPostSubmission,
  BindMediaPostSubmissionReference,
  RetryMediaPostSubmission,
  CancelMediaPostSubmission,
  ModerateMediaPostSubmission,
  GetTextContentSubmission,
  GetPost,
  CreateComment,
  CastPostVote,
  ClearPostVote,
  CreateCommentReply,
  ReportComment,
  ModerateCaseAction,
  GetPublicHomeFeed,
  GetPublicCommunityThreads,
  GetHomeFeed,
  GetJwks,
} as const;
