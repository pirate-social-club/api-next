export type PostSlugV1Fixture = Readonly<{
  name: string;
  source: string;
  locale?: string;
  postType: "text" | "song";
  expected:
    | Readonly<{ kind: "descriptive"; branch: "ascii" | "unicode"; slug: string }>
    | Readonly<{ kind: "opaque"; prefix: "post" | "song" }>;
}>;

const devanagariCluster = "कि";

export const postSlugV1GoldenFixtures = [
  {
    name: "folds Latin diacritics",
    source: "Déjà Vu",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "deja-vu" },
  },
  {
    name: "applies the German locale",
    source: "Straße Über Ärger",
    locale: "de",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "strasse-ueber-aerger" },
  },
  {
    name: "uses the Ukrainian word-initial mapping",
    source: "Щедрий вечір",
    locale: "uk",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "shchedryi-vechir" },
  },
  {
    name: "transliterates generic Cyrillic",
    source: "Привет мир",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "privet-mir" },
  },
  {
    name: "accepts an intentional empty soft-sign mapping",
    source: "День города",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "den-goroda" },
  },
  {
    name: "transliterates generic Greek",
    source: "Καλημέρα κόσμε",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "kalimera-kosme" },
  },
  {
    name: "pins a second Greek word",
    source: "Αθήνα",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "athina" },
  },
  {
    name: "transliterates Arabic with digits",
    source: "مرحبا 123",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "mrhba-123" },
  },
  {
    name: "pins a second Arabic word",
    source: "كتاب",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "ktab" },
  },
  {
    name: "keeps digits without nested-table corruption",
    source: "1234",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "1234" },
  },
  {
    name: "normalizes compatibility characters before ASCII formatting",
    source: "Ünïcödé ﬁnal ①",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "unicode-final-1" },
  },
  {
    name: "documents mixed-script homograph folding on the ASCII branch",
    source: "pаypal scam",
    postType: "text",
    expected: { kind: "descriptive", branch: "ascii", slug: "paypal-scam" },
  },
  {
    name: "falls back to Unicode when a Han run disappears",
    source: "你好 World",
    postType: "text",
    expected: { kind: "descriptive", branch: "unicode", slug: "你好-world" },
  },
  {
    name: "keeps Japanese script fidelity",
    source: "東京の夜 (live)",
    postType: "text",
    expected: { kind: "descriptive", branch: "unicode", slug: "東京の夜-live" },
  },
  {
    name: "requests a text opaque token for emoji-only input",
    source: "🔥🔥🔥",
    postType: "text",
    expected: { kind: "opaque", prefix: "post" },
  },
  {
    name: "requests a song opaque token for mixed unknown scripts",
    source: "Привет 漢",
    postType: "song",
    expected: { kind: "opaque", prefix: "song" },
  },
  {
    name: "uses Unicode rather than silently dropping an unmapped Cyrillic letter",
    source: "Привет ѫмир",
    postType: "text",
    expected: { kind: "descriptive", branch: "unicode", slug: "привет-ѫмир" },
  },
  {
    name: "truncates without splitting a Devanagari grapheme",
    source: devanagariCluster.repeat(41),
    postType: "text",
    expected: {
      kind: "descriptive",
      branch: "unicode",
      slug: devanagariCluster.repeat(40),
    },
  },
] as const satisfies ReadonlyArray<PostSlugV1Fixture>;
