import { type ToASCIIOptions, toASCII, toUnicode } from "tr46";

export const ROUTE_LABEL_CODEC_VERSION = "route-label-codec-v1" as const;
export const ROUTE_LABEL_INPUT_MAX_BYTES = 255;
export const HNS_ROUTE_ROOT_MAX_BYTES = 63;
export const SPACES_ROUTE_ROOT_MAX_BYTES = 62;

const HNS_ROUTE_ROOT_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/u;
const SPACES_ROUTE_ROOT_PATTERN = /^[a-z0-9-]+$/u;
const SPACES_ROUTE_ROOT_PAYLOAD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HNS_ROUTE_ROOT_BLACKLIST = new Set(["example", "invalid", "local", "localhost", "test"]);
const utf8Encoder = new TextEncoder();

const ROUTE_LABEL_CODEC_OPTIONS = {
  checkBidi: true,
  checkHyphens: false,
  checkJoiners: true,
  ignoreInvalidPunycode: false,
  transitionalProcessing: false,
  useSTD3ASCIIRules: false,
  verifyDNSLength: false,
} as const satisfies ToASCIIOptions;

export type RouteLabelFamilyV1 = "hns" | "spaces";

export type CanonicalRouteLabelV1 = Readonly<{
  readonly root_label: string;
  readonly root_label_display: string;
}>;

export type RouteLabelCodecResultV1 =
  | Readonly<{ readonly kind: "accepted"; readonly value: CanonicalRouteLabelV1 }>
  | Readonly<{ readonly kind: "rejected"; readonly reason: "invalid_root_label" }>;

function utf8Length(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

export function validRouteLabelInputV1(value: string): boolean {
  const length = utf8Length(value);
  return (
    length >= 1 &&
    length <= ROUTE_LABEL_INPUT_MAX_BYTES &&
    value === value.trim() &&
    !value.startsWith("@") &&
    !value.startsWith("app.") &&
    !value.includes(".") &&
    !value.includes("%") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !hasControlCharacter(value)
  );
}

export function validRouteLabelDisplayV1(value: string): boolean {
  const length = utf8Length(value);
  return (
    length >= 1 &&
    length <= ROUTE_LABEL_INPUT_MAX_BYTES &&
    value === value.normalize("NFC") &&
    !hasControlCharacter(value)
  );
}

function validHnsRouteRoot(value: string): boolean {
  const length = utf8Length(value);
  return (
    length >= 1 &&
    length <= HNS_ROUTE_ROOT_MAX_BYTES &&
    HNS_ROUTE_ROOT_PATTERN.test(value) &&
    !HNS_ROUTE_ROOT_BLACKLIST.has(value)
  );
}

function validSpacesRouteRoot(value: string): boolean {
  const length = utf8Length(value);
  if (
    length < 1 ||
    length > SPACES_ROUTE_ROOT_MAX_BYTES ||
    !SPACES_ROUTE_ROOT_PATTERN.test(value)
  ) {
    return false;
  }
  const payload = value.startsWith("xn--") && value.length > 4 ? value.slice(4) : value;
  return SPACES_ROUTE_ROOT_PAYLOAD_PATTERN.test(payload);
}

function validProtocolRouteRoot(family: RouteLabelFamilyV1, value: string): boolean {
  return family === "hns" ? validHnsRouteRoot(value) : validSpacesRouteRoot(value);
}

function rejected(): RouteLabelCodecResultV1 {
  return { kind: "rejected", reason: "invalid_root_label" };
}

/** Validates an exact canonical ACE label without applying write normalization. */
export function parseCanonicalRouteLabelV1(
  family: RouteLabelFamilyV1,
  rootLabel: string,
): RouteLabelCodecResultV1 {
  if (!validProtocolRouteRoot(family, rootLabel)) return rejected();

  try {
    const unicode = toUnicode(rootLabel, ROUTE_LABEL_CODEC_OPTIONS);
    if (unicode.error) return rejected();
    const rootLabelDisplay = unicode.domain.normalize("NFC");
    if (toASCII(rootLabelDisplay, ROUTE_LABEL_CODEC_OPTIONS) !== rootLabel) return rejected();
    return {
      kind: "accepted",
      value: { root_label: rootLabel, root_label_display: rootLabelDisplay },
    };
  } catch {
    return rejected();
  }
}

/** Canonicalizes a bounded mutation/preflight input through route-label-codec-v1. */
export function normalizeRouteLabelV1(
  family: RouteLabelFamilyV1,
  input: string,
): RouteLabelCodecResultV1 {
  if (!validRouteLabelInputV1(input)) return rejected();
  try {
    const rootLabel = toASCII(input, ROUTE_LABEL_CODEC_OPTIONS);
    return rootLabel === null ? rejected() : parseCanonicalRouteLabelV1(family, rootLabel);
  } catch {
    return rejected();
  }
}

export function canonicalRouteLabelMatchesV1(
  family: RouteLabelFamilyV1,
  rootLabel: string,
  rootLabelDisplay: string,
): boolean {
  const canonical = parseCanonicalRouteLabelV1(family, rootLabel);
  return canonical.kind === "accepted" && canonical.value.root_label_display === rootLabelDisplay;
}
