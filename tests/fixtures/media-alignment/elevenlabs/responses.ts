/** Checked-in provider-shaped responses used by the injected transport tests. */

export const multilingualWordsResponse = {
  characters: [
    { text: "П", start: 0, end: 0.04 },
    { text: "р", start: 0.04, end: 0.08 },
    { text: "и", start: 0.08, end: 0.12 },
    { text: "в", start: 0.12, end: 0.16 },
    { text: "е", start: 0.16, end: 0.2 },
    { text: "т", start: 0.2, end: 0.4 },
    { text: " ", start: 0.4, end: 0.5 },
    { text: "世", start: 0.5, end: 0.7 },
    { text: "界", start: 0.7, end: 0.9 },
    { text: "!", start: 0.9, end: 1.0 },
  ],
  words: [
    { text: "Привет", start: 0, end: 0.4, loss: 0.05 },
    { text: "世界!", start: 0.5, end: 1.0, loss: 0.07 },
  ],
  loss: 0.06,
} as const;

export const repeatedWordResponse = {
  characters: [
    { text: "g", start: 0, end: 0.1 },
    { text: "o", start: 0.1, end: 0.2 },
    { text: " ", start: 0.2, end: 0.3 },
    { text: "g", start: 0.3, end: 0.4 },
    { text: "o", start: 0.4, end: 0.5 },
  ],
  words: [
    { text: "go", start: 0, end: 0.2, loss: 0.1 },
    { text: "go", start: 0.3, end: 0.5, loss: 0.1 },
  ],
  loss: 0.1,
} as const;

export const characterResponse = {
  characters: [
    { text: "न", start: 0, end: 0.1 },
    { text: "म", start: 0.1, end: 0.2 },
    { text: "स", start: 0.2, end: 0.3 },
    { text: "्", start: 0.3, end: 0.4 },
    { text: "त", start: 0.4, end: 0.5 },
    { text: "े", start: 0.5, end: 0.6 },
  ],
  words: [{ text: "नमस्ते", start: 0, end: 0.6, loss: 0.2 }],
  loss: 0.2,
} as const;

export const noSpeechResponse = {
  characters: [],
  words: [],
  loss: 0,
} as const;

export const malformedResponse = {
  characters: [{ text: "h", start: 0, end: 1 }],
  words: [{ text: "hello", start: "not-a-number", end: 1, loss: 0.1 }],
  loss: 0,
} as const;

export const overlappingTimingResponse = {
  characters: [
    { text: "g", start: 0, end: 0.1 },
    { text: "o", start: 0.1, end: 0.2 },
    { text: " ", start: 0.2, end: 0.3 },
    { text: "g", start: 0.3, end: 0.4 },
    { text: "o", start: 0.4, end: 0.5 },
  ],
  words: [
    { text: "go", start: 0, end: 0.4, loss: 0.1 },
    { text: "go", start: 0.3, end: 0.5, loss: 0.1 },
  ],
  loss: 0.1,
} as const;

export const quantizedTimingResponse = {
  characters: [
    { text: "g", start: 0, end: 0 },
    { text: "o", start: 0, end: 0.1 },
    { text: " ", start: 0.1, end: 0.2 },
    { text: "g", start: 0.2, end: 0.3 },
    { text: "o", start: 0.3, end: 0.4 },
  ],
  words: [
    { text: "go", start: 0, end: 0.2, loss: 0.1 },
    { text: "go", start: 0.199, end: 0.4, loss: 0.1 },
  ],
  loss: 0.1,
} as const;
