/** Checked-in provider-shaped responses used by the injected transport tests. */

export const multilingualWordsResponse = {
  characters: ["П", "р", "и", "в", "е", "т", " ", "世", "界", "!"],
  character_start_times_seconds: [0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.4, 0.5, 0.7, 0.9],
  character_end_times_seconds: [0.04, 0.08, 0.12, 0.16, 0.2, 0.4, 0.5, 0.7, 0.9, 1.0],
  words: [
    { text: "Привет", start: 0, end: 0.4 },
    { text: " ", start: 0.4, end: 0.5 },
    { text: "世界", start: 0.5, end: 0.9 },
    { text: "!", start: 0.9, end: 1.0 },
  ],
  loss: 0,
} as const;

export const repeatedWordResponse = {
  characters: ["g", "o", " ", "g", "o"],
  character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5],
  words: [
    { text: "go", start: 0, end: 0.2 },
    { text: " ", start: 0.2, end: 0.3 },
    { text: "go", start: 0.3, end: 0.5 },
  ],
  loss: 0,
} as const;

export const characterResponse = {
  characters: ["न", "म", "स", "्", "त", "े"],
  character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
  words: [{ text: "नमस्ते", start: 0, end: 0.6 }],
  loss: 0,
} as const;

export const noSpeechResponse = {
  characters: [],
  character_start_times_seconds: [],
  character_end_times_seconds: [],
  words: [],
  loss: 0,
} as const;

export const malformedResponse = {
  characters: ["h"],
  character_start_times_seconds: [0],
  character_end_times_seconds: [1],
  words: [{ text: "hello", start: "not-a-number", end: 1 }],
  loss: 0,
} as const;

export const overlappingTimingResponse = {
  characters: ["g", "o", " ", "g", "o"],
  character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5],
  words: [
    { text: "go", start: 0, end: 0.4 },
    { text: " ", start: 0.3, end: 0.5 },
    { text: "go", start: 0.5, end: 0.7 },
  ],
  loss: 0,
} as const;
