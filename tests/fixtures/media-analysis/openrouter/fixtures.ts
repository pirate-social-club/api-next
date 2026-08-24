/** Hostile model/provider documents used by the isolated OpenRouter tests. */

const classified = {
  explicitness: "not_explicit",
  primary_language_bcp47: "en",
  secondary_language_bcp47: "ru",
  confidence: {
    explicitness: 0.91,
    primary_language: 0.8,
    secondary_language: 0.7,
  },
  evidence: [
    { kind: "explicitness", segment_index: 0, confidence: 0.91 },
    { kind: "primary_language", segment_index: 0, confidence: 0.8 },
    { kind: "secondary_language", segment_index: 1, confidence: 0.7 },
  ],
} as const;

export const validProviderResponse = {
  id: "completion-fixture",
  object: "chat.completion",
  model: "fixture/model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: JSON.stringify(classified) },
      finish_reason: "stop",
    },
  ],
} as const;

export const hostileModelDocuments = {
  prompt_injection: {
    ...classified,
    evidence: [{ kind: "explicitness", segment_index: 0, confidence: 0.5 }],
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

export const identityMismatchResponse = {
  ...validProviderResponse,
  model: "different/model",
} as const;

export const statusFixtures = {
  unauthorized: 401,
  invalid_request: 422,
  throttled: 429,
  unavailable: 503,
} as const;
