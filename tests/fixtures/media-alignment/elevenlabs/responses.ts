/** Checked-in provider-shaped responses used by the injected transport tests. */

export const multilingualWordsResponse = {
  words: [
    { text: "Привет", start: 0, end: 0.4, type: "word" },
    { text: " ", start: 0.4, end: 0.5, type: "spacing" },
    { text: "世界", start: 0.5, end: 0.9, type: "word" },
    { text: "!", start: 0.9, end: 1.0, type: "word" },
  ],
} as const;

export const repeatedWordResponse = {
  words: [
    { text: "go", start: 0, end: 0.2, type: "word" },
    { text: " ", start: 0.2, end: 0.3, type: "spacing" },
    { text: "go", start: 0.3, end: 0.5, type: "word" },
  ],
} as const;

export const characterResponse = {
  characters: ["न", "म", "स", "्", "त", "े"],
  character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
} as const;

export const noSpeechResponse = { words: [] } as const;

export const explicitNoSpeechResponse = { status: "no_speech" } as const;

export const malformedResponse = {
  words: [{ text: "hello", start: "not-a-number", end: 1, type: "word" }],
} as const;

export const overlappingTimingResponse = {
  words: [
    { text: "go", start: 0, end: 0.4, type: "word" },
    { text: " ", start: 0.3, end: 0.5, type: "spacing" },
    { text: "go", start: 0.5, end: 0.7, type: "word" },
  ],
} as const;
