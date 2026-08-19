import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AnalysisBlocked,
  AuthError,
  BadRequest,
  CommentsLocked,
  Conflict,
  GateUnsatisfied,
  InternalError,
  MembershipRequired,
  NotFound,
  ProviderUnavailable,
  RateLimited,
  VerificationRequired,
} from "./errors.ts";

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

const PathCommunity = Schema.Struct({ communityId: Schema.String });
const PathPublicCommunity = Schema.Struct({ communityRef: Schema.String });
const PathPost = Schema.Struct({ postId: Schema.String });
const PathComment = Schema.Struct({ commentId: Schema.String });

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

const AgentActionProof = Schema.Struct({
  nonce: Schema.String,
  signed_at: Schema.String,
  canonical_request_hash: Schema.String,
  signature: Schema.String,
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
  accepted_providers: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Literals(["self", "zkpassport", "very", "passport"]))),
  ),
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

const Post = Schema.Struct({
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

const LocalizedPost = Schema.Struct({
  post: Post,
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

const Comment = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("comment"),
  community: Schema.String,
  thread_root_post: Schema.String,
  parent_comment: Schema.NullOr(Schema.String),
  author_user: Schema.NullOr(Schema.String),
  author_public_handle: Schema.optional(Schema.NullOr(Schema.String)),
  authorship_mode: Schema.Literals(["human_direct", "user_agent", "guest"]),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  agent_ownership_record: Schema.optional(Schema.NullOr(Schema.String)),
  identity_mode: Schema.Literals(["public", "anonymous"]),
  anonymous_scope: Schema.NullOr(Schema.Literals(["community_stable", "thread_stable"])),
  anonymous_label: Schema.NullOr(Schema.String),
  agent_handle_snapshot: Schema.optional(Schema.NullOr(Schema.String)),
  agent_display_name_snapshot: Schema.optional(Schema.NullOr(Schema.String)),
  agent_owner_handle_snapshot: Schema.optional(Schema.NullOr(Schema.String)),
  agent_ownership_provider_snapshot: Schema.optional(
    Schema.NullOr(Schema.Literals(["self_agent_id", "clawkey"])),
  ),
  body: Schema.NullOr(Schema.String),
  media_refs: Schema.optional(Schema.Array(JsonValue)),
  source_language: Schema.optional(Schema.NullOr(Schema.String)),
  source_language_confidence: Schema.optional(Schema.NullOr(Schema.Number)),
  source_language_reliable: Schema.optional(Schema.Boolean),
  source_language_detector: Schema.optional(Schema.NullOr(Schema.String)),
  source_language_detected_at: Schema.optional(Schema.NullOr(Schema.String)),
  source_language_source_hash: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.Literals(["published", "hidden", "removed", "deleted"]),
  replies_locked: Schema.optional(Schema.Boolean),
  replies_locked_at: Schema.optional(Schema.NullOr(Schema.Number)),
  replies_locked_by_user: Schema.optional(Schema.NullOr(Schema.String)),
  replies_lock_reason: Schema.optional(Schema.NullOr(Schema.String)),
  depth: Schema.Number,
  direct_reply_count: Schema.Number,
  descendant_count: Schema.Number,
  upvote_count: Schema.Number,
  downvote_count: Schema.Number,
  score: Schema.Number,
  last_reply_at: Schema.optional(Schema.NullOr(Schema.Number)),
  content_hash: Schema.NullOr(Schema.String),
  swarm_body_ref: Schema.NullOr(Schema.String),
  idempotency_key: Schema.NullOr(Schema.String),
  created: Schema.Number,
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
  agent_id: Schema.optional(Schema.NullOr(Schema.String)),
  agent_action_proof: Schema.optional(Schema.NullOr(AgentActionProof)),
  identity_mode: Schema.optional(Schema.Literals(["public", "anonymous"])),
  anonymous_scope: Schema.optional(Schema.NullOr(Schema.String)),
  disclosed_qualifier_ids: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  parent_post_id: Schema.optional(Schema.NullOr(Schema.String)),
  label_id: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  caption: Schema.optional(Schema.NullOr(Schema.String)),
  link_url: Schema.optional(Schema.NullOr(Schema.String)),
  media_refs: Schema.optional(Schema.Array(JsonValue)),
  creator_relation: Schema.optional(Schema.NullOr(JsonObject)),
  promotion_disclosure: Schema.optional(Schema.NullOr(JsonObject)),
  translation_policy: Schema.optional(
    Schema.Literals(["none", "machine_allowed", "human_only", "hybrid"]),
  ),
  visibility: Schema.optional(Schema.Literals(["public", "members_only"])),
  age_gate_policy: Schema.optional(Schema.NullOr(Schema.Literals(["none", "18_plus"]))),
  access_mode: Schema.optional(Schema.NullOr(Schema.Literals(["public", "locked"]))),
  asset_id: Schema.optional(Schema.NullOr(Schema.String)),
  file_upload: Schema.optional(Schema.NullOr(Schema.String)),
  song_artifact_bundle: Schema.optional(Schema.NullOr(Schema.String)),
  song_mode: Schema.optional(Schema.NullOr(Schema.Literals(["original", "remix"]))),
  rights_basis: Schema.optional(
    Schema.NullOr(Schema.Literals(["none", "original", "derivative", "attribution_only"])),
  ),
  upstream_asset_refs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  license_preset: Schema.optional(
    Schema.NullOr(Schema.Literals(["non-commercial", "commercial-use", "commercial-remix"])),
  ),
  commercial_rev_share_pct: Schema.optional(Schema.NullOr(Schema.Number)),
  royalty_allocations: Schema.optional(Schema.NullOr(Schema.Array(JsonObject))),
  lyrics: Schema.optional(Schema.NullOr(Schema.String)),
  source_post: Schema.optional(Schema.NullOr(Schema.String)),
  source_community: Schema.optional(Schema.NullOr(Schema.String)),
  crosspost_source: Schema.optional(Schema.NullOr(JsonObject)),
  event: Schema.optional(Schema.NullOr(JsonObject)),
  publish_mode: Schema.optional(Schema.Literals(["sync", "async"])),
  listing_draft: Schema.optional(Schema.NullOr(JsonObject)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
};

const CreatePostRequest = Schema.Union([
  Schema.Struct({ ...CreatePostCommon, post_type: Schema.Literal("text") }),
  Schema.Struct({
    ...CreatePostCommon,
    post_type: Schema.Literal("image"),
    media_refs: Schema.Array(JsonValue),
  }),
  Schema.Struct({
    ...CreatePostCommon,
    post_type: Schema.Literal("video"),
    media_refs: Schema.Array(JsonValue),
  }),
  Schema.Struct({
    ...CreatePostCommon,
    post_type: Schema.Literal("link"),
    link_url: Schema.String,
  }),
  Schema.Struct({ ...CreatePostCommon, post_type: Schema.Literal("song") }),
  Schema.Struct({
    ...CreatePostCommon,
    post_type: Schema.Literal("file"),
    title: Schema.String,
    file_upload: Schema.String,
    access_mode: Schema.Literals(["public", "locked"]),
  }),
  Schema.Struct({
    ...CreatePostCommon,
    post_type: Schema.Literal("crosspost"),
    title: Schema.String,
    source_post: Schema.String,
    source_community: Schema.String,
  }),
]);

const CreateComment = Schema.Struct({
  idempotency_key: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  media_refs: Schema.optional(Schema.Array(JsonValue)),
  authorship_mode: Schema.optional(Schema.Literals(["human_direct", "user_agent", "guest"])),
  agent_id: Schema.optional(Schema.NullOr(Schema.String)),
  agent_action_proof: Schema.optional(Schema.NullOr(AgentActionProof)),
  identity_mode: Schema.optional(Schema.Literals(["public", "anonymous"])),
  anonymous_scope: Schema.optional(
    Schema.NullOr(Schema.Literals(["community_stable", "thread_stable"])),
  ),
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

const JoinEligibility = Schema.Struct({
  community: Schema.String,
  membership_mode: Schema.Literals(["open", "request", "gated"]),
  human_verification_lane: Schema.NullOr(Schema.Literals(["very", "self"])),
  preferred_verification_provider: Schema.optional(
    Schema.NullOr(Schema.Literals(["self", "zkpassport", "very"])),
  ),
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
        "age_over_18",
        "minimum_age",
        "nationality",
        "gender",
        "wallet_score",
        "altcha_pow",
      ]),
    ),
  ),
  suggested_verification_provider: Schema.optional(
    Schema.NullOr(Schema.Literals(["self", "zkpassport", "very", "passport"])),
  ),
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
});

export const GetJoinEligibility = endpoint({
  method: "GET",
  path: "/communities/:communityId/join-eligibility",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity },
  response: JoinEligibility,
  successStatus: 200,
  errors: [AuthError, NotFound],
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
  auth: Auth.userOrAdminOrAgentDelegated("posts"),
  request: { path: PathCommunity, body: CreatePostRequest },
  response: Post,
  successStatus: [201, 202],
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    GateUnsatisfied,
    MembershipRequired,
    NotFound,
    ProviderUnavailable,
    RateLimited,
    AnalysisBlocked,
  ],
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

const VoteRequest = Schema.Struct({
  value: Schema.Literals([-1, 1]),
  altcha: Schema.optional(Schema.String),
});
const VoteResponse = Schema.Struct({
  post: Schema.String,
  value: Schema.Literals([-1, 1]),
});
const ClearVoteResponse = Schema.Struct({
  post: Schema.String,
  value: Schema.Null,
});

export const CastPostVote = endpoint({
  method: "POST",
  path: "/posts/:postId/vote",
  auth: Auth.userOrAdmin({ altcha: "vote" }),
  request: { path: PathPost, body: VoteRequest },
  response: VoteResponse,
  successStatus: 200,
  errors: [
    AuthError,
    BadRequest,
    VerificationRequired,
    MembershipRequired,
    GateUnsatisfied,
    NotFound,
    RateLimited,
  ],
});

export const ClearPostVote = endpoint({
  method: "POST",
  path: "/posts/:postId/clear_vote",
  auth: Auth.userOrAdmin({ altcha: "vote" }),
  request: {
    path: PathPost,
    body: Schema.Struct({ altcha: Schema.optional(Schema.String) }),
    bodyRequired: false,
  },
  response: ClearVoteResponse,
  successStatus: 200,
  errors: [
    AuthError,
    BadRequest,
    VerificationRequired,
    MembershipRequired,
    GateUnsatisfied,
    NotFound,
    RateLimited,
  ],
});

export const CreateCommentReply = endpoint({
  method: "POST",
  path: "/comments/:commentId/replies",
  auth: Auth.userOrAdminOrAgentDelegated("comments"),
  request: { path: PathComment, body: CreateComment },
  response: Comment,
  successStatus: 201,
  errors: [
    AuthError,
    BadRequest,
    CommentsLocked,
    Conflict,
    GateUnsatisfied,
    MembershipRequired,
    NotFound,
    RateLimited,
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
  request: { path: PathPublicCommunity, query: PublicCommunityThreadsQuery },
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
