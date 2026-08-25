/** Hostile model/provider documents used by the isolated OpenRouter tests. */

const classified = {
  explicitness: "not_explicit",
  transcript_explicitness: "not_explicit",
  lyrics_explicitness: "not_explicit",
  material_disagreement: false,
  primary_language_bcp47: "en",
  secondary_language_bcp47: "ru",
  confidence: {
    explicitness: 0.91,
    primary_language: 0.8,
    secondary_language: 0.7,
  },
  evidence: [
    { kind: "explicitness", source: "transcript", segment_index: 0, confidence: 0.91 },
    { kind: "primary_language", source: "transcript", segment_index: 0, confidence: 0.8 },
    { kind: "secondary_language", source: "transcript", segment_index: 1, confidence: 0.7 },
  ],
} as const;

export const validProviderResponse = {
  id: "completion-fixture",
  object: "chat.completion",
  created: 1_724_500_000,
  model: "fixture/model",
  system_fingerprint: "fingerprint-fixture",
  service_tier: "default",
  usage: { prompt_tokens: 64, completion_tokens: 32, total_tokens: 96 },
  openrouter_metadata: {
    requested: "fixture/model",
    strategy: "direct",
    region: "iad",
    summary: "available=1, selected=FixtureProvider",
    attempt: 1,
    is_byok: false,
    endpoints: {
      total: 1,
      available: [{ provider: "FixtureProvider", model: "fixture/model", selected: true }],
    },
    params: {
      quality_floor: 0.5,
      additive_router_hint: { bounded: true },
    },
    attempts: [{ provider: "FixtureProvider", model: "fixture/model", status: 200 }],
    pipeline: [
      {
        type: "guardrail",
        name: "fixture-stage",
        guardrail_id: "grd-fixture",
        guardrail_scope: "api-key",
        data: { flagged: false, additive_stage_data: ["bounded"] },
      },
    ],
  },
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: JSON.stringify(classified) },
      finish_reason: "stop",
    },
  ],
} as const;

export const providerPolicy = {
  require_parameters: true,
  data_collection: "deny",
  zdr: true,
  allow_fallbacks: false,
  sort: "price",
  order: ["FixtureProvider"],
  only: ["FixtureProvider"],
  ignore: [],
} as const;

export const hostileModelDocuments = {
  prompt_injection: {
    ...classified,
    evidence: [{ kind: "explicitness", source: "transcript", segment_index: 0, confidence: 0.5 }],
  },
  prose: "The song is not explicit and is in English.",
  markdown: `\`\`\`json\n{${JSON.stringify(classified).slice(1)}\n\`\`\``,
  tool_call: {
    ...classified,
    tool_calls: [{ name: "disclose_secret", arguments: "{}" }],
  },
  refusal: { refusal: "I cannot comply" },
  unknown_key: { ...classified, policy_decision: "safe" },
  invalid_language: { ...classified, primary_language_bcp47: "EN_us" },
  out_of_bounds_evidence: {
    ...classified,
    evidence: classified.evidence.map((item) => ({ ...item, segment_index: 99 })),
  },
} as const;

export const multipleChoicesResponse = {
  choices: [validProviderResponse.choices[0], validProviderResponse.choices[0]],
} as const;

export const zeroChoicesResponse = {
  ...validProviderResponse,
  choices: [],
} as const;

export const wrongIndexResponse = {
  ...validProviderResponse,
  choices: [{ ...validProviderResponse.choices[0], index: 1 }],
} as const;

export const nonStopFinishResponse = {
  ...validProviderResponse,
  choices: [{ ...validProviderResponse.choices[0], finish_reason: "length" }],
} as const;

export const identityMismatchResponse = {
  ...validProviderResponse,
  model: "different/model",
} as const;

export const missingMetadataResponse = {
  ...validProviderResponse,
  openrouter_metadata: undefined,
} as const;

export const conflictingProviderResponse = {
  ...validProviderResponse,
  openrouter_metadata: {
    ...validProviderResponse.openrouter_metadata,
    endpoints: {
      total: 2,
      available: [
        { provider: "FixtureProvider", model: "fixture/model", selected: true },
        { provider: "SecondProvider", model: "fixture/model", selected: true },
      ],
    },
  },
} as const;

export const authorityChoiceResponse = {
  ...validProviderResponse,
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify(classified),
        refusal: "must be rejected",
        tool_calls: [],
      },
    },
  ],
} as const;

export const identityMatrixResponses = {
  missing_metadata: { ...validProviderResponse, openrouter_metadata: undefined },
  missing_completion_id: { ...validProviderResponse, id: undefined },
  null_completion_id: { ...validProviderResponse, id: null },
  missing_served_model: { ...validProviderResponse, model: undefined },
  null_served_model: { ...validProviderResponse, model: null },
  missing_requested_model: {
    ...validProviderResponse,
    openrouter_metadata: { ...validProviderResponse.openrouter_metadata, requested: undefined },
  },
  null_requested_model: {
    ...validProviderResponse,
    openrouter_metadata: { ...validProviderResponse.openrouter_metadata, requested: null },
  },
  requested_model_mismatch: {
    ...validProviderResponse,
    openrouter_metadata: { ...validProviderResponse.openrouter_metadata, requested: "other/model" },
  },
  missing_endpoints: {
    ...validProviderResponse,
    openrouter_metadata: { ...validProviderResponse.openrouter_metadata, endpoints: undefined },
  },
  missing_selected_provider: {
    ...validProviderResponse,
    openrouter_metadata: {
      ...validProviderResponse.openrouter_metadata,
      endpoints: {
        total: 1,
        available: [{ model: "fixture/model", selected: true }],
      },
    },
  },
  missing_endpoint_model: {
    ...validProviderResponse,
    openrouter_metadata: {
      ...validProviderResponse.openrouter_metadata,
      endpoints: {
        total: 1,
        available: [{ provider: "FixtureProvider", selected: true }],
      },
    },
  },
  null_selected_provider: {
    ...validProviderResponse,
    openrouter_metadata: {
      ...validProviderResponse.openrouter_metadata,
      endpoints: {
        total: 1,
        available: [{ provider: null, model: "fixture/model", selected: true }],
      },
    },
  },
  null_endpoint_model: {
    ...validProviderResponse,
    openrouter_metadata: {
      ...validProviderResponse.openrouter_metadata,
      endpoints: {
        total: 1,
        available: [{ provider: "FixtureProvider", model: null, selected: true }],
      },
    },
  },
  missing_selection: {
    ...validProviderResponse,
    openrouter_metadata: {
      ...validProviderResponse.openrouter_metadata,
      endpoints: {
        total: 1,
        available: [{ provider: "FixtureProvider", model: "fixture/model" }],
      },
    },
  },
  selection_conflict: {
    ...validProviderResponse,
    openrouter_metadata: {
      ...validProviderResponse.openrouter_metadata,
      endpoints: {
        total: 2,
        available: [
          { provider: "FixtureProvider", model: "fixture/model", selected: true },
          { provider: "SecondProvider", model: "fixture/model", selected: true },
        ],
      },
    },
  },
} as const;

export const unknownRootFieldResponse = {
  ...validProviderResponse,
  authority: "must-not-be-accepted",
} as const;

export const unboundedMetadataResponse = {
  ...validProviderResponse,
  openrouter_metadata: {
    ...validProviderResponse.openrouter_metadata,
    params: { oversized: "x".repeat(5_000) },
  },
} as const;

export const statusFixtures = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  timeout: 408,
  too_large: 413,
  invalid_request: 422,
  throttled: 429,
  internal: 500,
  bad_gateway: 502,
  unavailable: 503,
  gateway_timeout: 504,
} as const;
