/**
 * Deterministic English text-to-approximate-phoneme primitives shared by Study
 * and Karaoke. These compare transcript text; they do not measure pronunciation,
 * accent, or any acoustic property of a recording.
 */
export type EnglishPhoneticStreamSimilarity = Readonly<{
  available: boolean;
  distance: number;
  length: number;
  similarity: number;
}>;

export const latinLettersOnly = (raw: string): string => raw.toLowerCase().replace(/[^a-z]/gu, "");

const similarPhonemePairs: Array<[string, string]> = [
  ["AA", "AH"],
  ["AE", "EH"],
  ["IH", "IY"],
  ["UH", "UW"],
  ["AO", "OW"],
  ["P", "B"],
  ["T", "D"],
  ["K", "G"],
  ["F", "V"],
  ["S", "Z"],
  ["TH", "DH"],
  ["SH", "ZH"],
  ["CH", "JH"],
  ["M", "N"],
  ["L", "R"],
  ["W", "Y"],
  ["ER", "R"],
];

const vowels = new Set(["a", "e", "i", "o", "u", "y"]);

const similarPhonemeMap: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const [left, right] of similarPhonemePairs) {
    if (!map.has(left)) map.set(left, new Set());
    if (!map.has(right)) map.set(right, new Set());
    map.get(left)?.add(right);
    map.get(right)?.add(left);
  }
  return map;
})();

const irregularArpabet: Record<string, string[]> = {
  are: ["AA", "R"],
  be: ["B", "IY"],
  been: ["B", "IH", "N"],
  could: ["K", "UH", "D"],
  do: ["D", "UW"],
  does: ["D", "AH", "Z"],
  done: ["D", "AH", "N"],
  dont: ["D", "OW", "N", "T"],
  from: ["F", "R", "AH", "M"],
  going: ["G", "OW", "IH", "NG"],
  have: ["HH", "AE", "V"],
  hello: ["HH", "AH", "L", "OW"],
  i: ["AY"],
  im: ["AY", "M"],
  ive: ["AY", "V"],
  know: ["N", "OW"],
  one: ["W", "AH", "N"],
  said: ["S", "EH", "D"],
  says: ["S", "EH", "Z"],
  some: ["S", "AH", "M"],
  the: ["DH", "AH"],
  their: ["DH", "EH", "R"],
  there: ["DH", "EH", "R"],
  they: ["DH", "EY"],
  though: ["DH", "OW"],
  thought: ["TH", "AO", "T"],
  through: ["TH", "R", "UW"],
  to: ["T", "UW"],
  two: ["T", "UW"],
  want: ["W", "AA", "N", "T"],
  was: ["W", "AA", "Z"],
  we: ["W", "IY"],
  were: ["W", "ER"],
  what: ["W", "AH", "T"],
  who: ["HH", "UW"],
  why: ["W", "AY"],
  you: ["Y", "UW"],
  your: ["Y", "AO", "R"],
  bought: ["B", "AO", "T"],
  brought: ["B", "R", "AO", "T"],
  cough: ["K", "AO", "F"],
  dough: ["D", "OW"],
  enough: ["IH", "N", "AH", "F"],
  fought: ["F", "AO", "T"],
  rough: ["R", "AH", "F"],
  tough: ["T", "AH", "F"],
};

const commonWordArpabet: Record<string, string[]> = {
  about: ["AH", "B", "AW", "T"],
  after: ["AE", "F", "T", "ER"],
  again: ["AH", "G", "EH", "N"],
  all: ["AO", "L"],
  also: ["AO", "L", "S", "OW"],
  and: ["AE", "N", "D"],
  any: ["EH", "N", "IY"],
  back: ["B", "AE", "K"],
  because: ["B", "IH", "K", "AO", "Z"],
  before: ["B", "IH", "F", "AO", "R"],
  being: ["B", "IY", "IH", "NG"],
  between: ["B", "IH", "T", "W", "IY", "N"],
  but: ["B", "AH", "T"],
  by: ["B", "AY"],
  can: ["K", "AE", "N"],
  cant: ["K", "AE", "N", "T"],
  come: ["K", "AH", "M"],
  day: ["D", "EY"],
  even: ["IY", "V", "AH", "N"],
  every: ["EH", "V", "R", "IY"],
  first: ["F", "ER", "S", "T"],
  for: ["F", "AO", "R"],
  get: ["G", "EH", "T"],
  give: ["G", "IH", "V"],
  good: ["G", "UH", "D"],
  had: ["HH", "AE", "D"],
  has: ["HH", "AE", "Z"],
  her: ["HH", "ER"],
  here: ["HH", "IH", "R"],
  him: ["HH", "IH", "M"],
  his: ["HH", "IH", "Z"],
  how: ["HH", "AW"],
  if: ["IH", "F"],
  into: ["IH", "N", "T", "UW"],
  its: ["IH", "T", "S"],
  just: ["JH", "AH", "S"],
  like: ["L", "AY", "K"],
  look: ["L", "UH", "K"],
  make: ["M", "EY", "K"],
  man: ["M", "AE", "N"],
  many: ["M", "EH", "N", "IY"],
  me: ["M", "IY"],
  more: ["M", "AO", "R"],
  most: ["M", "OW", "S", "T"],
  much: ["M", "AH", "CH"],
  must: ["M", "AH", "S", "T"],
  my: ["M", "AY"],
  new: ["N", "UW"],
  no: ["N", "OW"],
  not: ["N", "AA", "T"],
  now: ["N", "AW"],
  of: ["AH", "V"],
  on: ["AA", "N"],
  only: ["OW", "N", "L", "IY"],
  or: ["AO", "R"],
  other: ["AH", "DH", "ER"],
  our: ["AW", "ER"],
  out: ["AW", "T"],
  over: ["OW", "V", "ER"],
  people: ["P", "IY", "P", "AH", "L"],
  right: ["R", "AY", "T"],
  see: ["S", "IY"],
  she: ["SH", "IY"],
  should: ["SH", "UH", "D"],
  so: ["S", "OW"],
  take: ["T", "EY", "K"],
  than: ["DH", "AE", "N"],
  that: ["DH", "AE", "T"],
  them: ["DH", "EH", "M"],
  // biome-ignore lint/suspicious/noThenProperty: this is a phoneme dictionary entry, not a thenable.
  then: ["DH", "EH", "N"],
  these: ["DH", "IY", "Z"],
  thing: ["TH", "IH", "NG"],
  think: ["TH", "IH", "NG", "K"],
  this: ["DH", "IH", "S"],
  time: ["T", "AY", "M"],
  too: ["T", "UW"],
  use: ["Y", "UW", "Z"],
  very: ["V", "EH", "R", "IY"],
  way: ["W", "EY"],
  well: ["W", "EH", "L"],
  when: ["W", "EH", "N"],
  which: ["W", "IH", "CH"],
  while: ["W", "AY", "L"],
  will: ["W", "IH", "L"],
  with: ["W", "IH", "TH"],
  word: ["W", "ER", "D"],
  work: ["W", "ER", "K"],
  world: ["W", "ER", "L", "D"],
  would: ["W", "UH", "D"],
  yeah: ["Y", "EH"],
  yes: ["Y", "EH", "S"],
};

const arpabet = { ...commonWordArpabet, ...irregularArpabet };
const stemSuffixes = [
  "ingly",
  "edly",
  "tion",
  "sion",
  "ness",
  "ment",
  "able",
  "ible",
  "ing",
  "ied",
  "ies",
  "ers",
  "est",
  "ful",
  "ous",
  "ive",
  "ed",
  "er",
  "es",
  "ly",
  "s",
];

const multiCharacterPhonemes = [
  { seq: "through", phones: ["TH", "R", "UW"] },
  { seq: "ought", phones: ["AO", "T"] },
  { seq: "ough", phones: ["AH", "F"] },
  { seq: "ight", phones: ["AY", "T"] },
  { seq: "ould", phones: ["UH", "D"] },
  { seq: "tion", phones: ["SH", "AH", "N"] },
  { seq: "sion", phones: ["ZH", "AH", "N"] },
  { seq: "ture", phones: ["CH", "ER"] },
  { seq: "eigh", phones: ["EY"] },
  { seq: "ei", phones: ["EY"] },
  { seq: "igh", phones: ["AY"] },
  { seq: "dge", phones: ["JH"] },
  { seq: "tch", phones: ["CH"] },
  { seq: "ph", phones: ["F"] },
  { seq: "sh", phones: ["SH"] },
  { seq: "ch", phones: ["CH"] },
  { seq: "th", phones: ["TH"] },
  { seq: "ng", phones: ["NG"] },
  { seq: "ck", phones: ["K"] },
  { seq: "qu", phones: ["K", "W"] },
  { seq: "wr", phones: ["R"] },
  { seq: "kn", phones: ["N"] },
  { seq: "gn", phones: ["N"] },
  { seq: "wh", phones: ["W"] },
  { seq: "ee", phones: ["IY"] },
  { seq: "ea", phones: ["IY"] },
  { seq: "oo", phones: ["UW"] },
  { seq: "ou", phones: ["AW"] },
  { seq: "ow", phones: ["AW"] },
  { seq: "oi", phones: ["OY"] },
  { seq: "oy", phones: ["OY"] },
  { seq: "ai", phones: ["EY"] },
  { seq: "ay", phones: ["EY"] },
  { seq: "au", phones: ["AO"] },
  { seq: "aw", phones: ["AO"] },
  { seq: "er", phones: ["ER"] },
  { seq: "ir", phones: ["ER"] },
  { seq: "ur", phones: ["ER"] },
].sort((left, right) => right.seq.length - left.seq.length);

export const phoneticKey = (raw: string): string => {
  let value = latinLettersOnly(raw);
  if (!value) return "";
  value = value
    .replace(/^kn/u, "n")
    .replace(/^gn/u, "n")
    .replace(/^wr/u, "r")
    .replace(/^wh/u, "w")
    .replace(/^x/u, "s")
    .replace(/mb$/u, "m")
    .replace(/tch/gu, "ch")
    .replace(/dge/gu, "j")
    .replace(/ph/gu, "f")
    .replace(/qu/gu, "k")
    .replace(/ck/gu, "k")
    .replace(/sch/gu, "sk")
    .replace(/sh/gu, "x")
    .replace(/ch/gu, "x")
    .replace(/th/gu, "th")
    .replace(/dg/gu, "j")
    .replace(/c(?=[eiy])/gu, "s")
    .replace(/c/gu, "k")
    .replace(/g(?=[eiy])/gu, "j")
    .replace(/x/gu, "ks")
    .replace(/z/gu, "s")
    .replace(/(.)\1+/gu, "$1");
  return value.length <= 1 ? value : `${value[0]}${value.slice(1).replace(/[aeiouy]/gu, "")}`;
};

const stemCandidateWords = (word: string): string[] => {
  if (!word) return [];
  const candidates = [word];
  for (const suffix of stemSuffixes) {
    if (!word.endsWith(suffix) || word.length <= suffix.length + 2) continue;
    const base = word.slice(0, -suffix.length);
    candidates.push(base);
    if (!base.endsWith("e")) candidates.push(`${base}e`);
  }
  return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
};

const characterPhones = (
  character: string,
  next: string,
  isLast: boolean,
  wordLength: number,
): string[] => {
  switch (character) {
    case "a":
      return isLast ? ["AH"] : ["AE"];
    case "b":
      return ["B"];
    case "c":
      return ["K"];
    case "d":
      return ["D"];
    case "e":
      return isLast ? ["IY"] : ["EH"];
    case "f":
      return ["F"];
    case "g":
      return ["G"];
    case "h":
      return ["HH"];
    case "i":
      return ["IH"];
    case "j":
      return ["JH"];
    case "k":
      return ["K"];
    case "l":
      return ["L"];
    case "m":
      return ["M"];
    case "n":
      return ["N"];
    case "o":
      return isLast ? ["OW"] : ["AA"];
    case "p":
      return ["P"];
    case "q":
      return ["K"];
    case "r":
      return ["R"];
    case "s":
      return ["S"];
    case "t":
      return ["T"];
    case "u":
      return ["AH"];
    case "v":
      return ["V"];
    case "w":
      return ["W"];
    case "x":
      return ["K", "S"];
    case "y":
      if (isLast) return wordLength <= 3 ? ["AY"] : ["IY"];
      return !next || !vowels.has(next) ? ["IH"] : ["Y"];
    case "z":
      return ["Z"];
    default:
      return [];
  }
};

export const wordToApproxArpabet = (raw: string): string[] => {
  const word = latinLettersOnly(raw);
  if (!word) return [];
  for (const candidate of stemCandidateWords(word)) {
    const known = arpabet[candidate];
    if (known) return known;
  }
  if (word.endsWith("ied") && word.length > 3) {
    const basePhones = wordToApproxArpabet(`${word.slice(0, -3)}y`);
    if (basePhones.length > 0) return [...basePhones, "D"];
  }

  const phones: string[] = [];
  const trailingOwAwWords = new Set([
    "how",
    "now",
    "cow",
    "wow",
    "brow",
    "brown",
    "crown",
    "down",
    "town",
    "frown",
    "gown",
  ]);
  let index = 0;
  while (index < word.length) {
    const character = word[index] ?? "";
    const isLast = index === word.length - 1;
    const previous = index > 0 ? (word[index - 1] ?? "") : "";
    const next = index + 1 < word.length ? (word[index + 1] ?? "") : "";

    if (!isLast && next === "r" && /[aeiou]/u.test(character)) {
      if (character === "a") phones.push("AA", "R");
      else if (character === "e" || character === "i" || character === "u") phones.push("ER");
      else if (character === "o") phones.push("AO", "R");
      else phones.push("ER");
      index += 2;
      continue;
    }
    if (character === "o" && next === "w" && index === word.length - 2) {
      phones.push(trailingOwAwWords.has(word) ? "AW" : "OW");
      index += 2;
      continue;
    }

    const phoneme = multiCharacterPhonemes.find((candidate) =>
      word.startsWith(candidate.seq, index),
    );
    if (phoneme) {
      phones.push(...phoneme.phones);
      index += phoneme.seq.length;
      continue;
    }
    if (
      character === "e" &&
      isLast &&
      word.length > 3 &&
      !word.endsWith("le") &&
      !word.endsWith("ue") &&
      !vowels.has(previous) &&
      /[aeiou]/u.test(word.slice(0, -1))
    ) {
      index += 1;
      continue;
    }
    if (character === "c" && index + 1 < word.length && /[eiy]/u.test(next)) {
      phones.push("S");
      index += 1;
      continue;
    }
    if (character === "g" && index + 1 < word.length && /[eiy]/u.test(next)) {
      phones.push("JH");
      index += 1;
      continue;
    }
    phones.push(...characterPhones(character, next, isLast, word.length));
    index += 1;
  }

  const compact: string[] = [];
  for (const phone of phones) {
    if (phone && compact.at(-1) !== phone) compact.push(phone);
  }
  return compact;
};

export const phonemeDistance = (left: string[], right: string[]): number => {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) previous[index] = index;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const leftPhone = left[leftIndex - 1] ?? "";
      const rightPhone = right[rightIndex - 1] ?? "";
      const similar = similarPhonemeMap.get(leftPhone)?.has(rightPhone) === true;
      const substitutionCost = leftPhone === rightPhone ? 0 : similar ? 0.35 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitutionCost,
      );
    }
    for (let index = 0; index <= right.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }
  return previous[right.length] ?? 0;
};

export const phonemeSimilarity = (expected: string, transcript: string): number => {
  const expectedPhones = wordToApproxArpabet(expected);
  const transcriptPhones = wordToApproxArpabet(transcript);
  if (expectedPhones.length === 0 || transcriptPhones.length === 0) return 0;
  const denominator = Math.max(expectedPhones.length, transcriptPhones.length);
  return denominator <= 0
    ? 1
    : Math.max(0, 1 - phonemeDistance(expectedPhones, transcriptPhones) / denominator);
};

const tokenPhonemeStream = (tokens: readonly string[]): string[] => {
  const stream: string[] = [];
  for (const token of tokens) {
    const phones = wordToApproxArpabet(token);
    if (phones.length > 0) {
      stream.push(...phones);
      continue;
    }
    if (latinLettersOnly(token).length > 0) {
      const fallback = phoneticKey(token);
      if (fallback.length > 0) stream.push(fallback);
    }
  }
  return stream;
};

export const phoneticStreamSimilarity = (
  expectedTokens: readonly string[],
  transcriptTokens: readonly string[],
): EnglishPhoneticStreamSimilarity => {
  const expectedStream = tokenPhonemeStream(expectedTokens);
  const transcriptStream = tokenPhonemeStream(transcriptTokens);
  const distance = phonemeDistance(expectedStream, transcriptStream);
  const length = Math.max(expectedStream.length, transcriptStream.length, 1);
  return {
    available: expectedStream.length > 0 && transcriptStream.length > 0,
    distance,
    length,
    similarity: Math.max(0, 1 - distance / length),
  };
};
