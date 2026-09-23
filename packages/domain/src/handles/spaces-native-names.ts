import { parseCanonicalRouteLabelV1 } from "@pirate/route-label-codec";

/**
 * Spaces subordinate-label grammar `spaces_subspace_label_v1` (spec 012
 * §5.3.13.3), frozen from the pinned upstream subspace-name parser:
 * spaces_protocol 0.4.2 (`slabel.rs`, `MAX_LABEL_LEN = 62`, and `sname.rs`)
 * as resolved by subs 4dcc923. The upstream label syntax admits lower-case
 * ASCII letters, digits, and interior single hyphens, strips an `xn--` marker
 * before checking, and treats `#` as the numeric-space form. The target
 * restrictions narrow it to canonical lower-case ASCII only, reject `xn--`
 * subordinate labels, and reject the structural `.`, `#`, and `@`. Client
 * input is never trimmed, case folded, decoded, or normalized: a label
 * matches byte for byte or is refused. The grammar is a strict subset of
 * `hns_ascii_ldh_1_63_v1`.
 */
const SPACES_SUBSPACE_LABEL_MAX_BYTES = 62;
const SPACES_SUBSPACE_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isCanonicalSpacesSubspaceLabelV1(label: string): boolean {
  const byteLength = new TextEncoder().encode(label).byteLength;
  return (
    byteLength >= 1 &&
    byteLength <= SPACES_SUBSPACE_LABEL_MAX_BYTES &&
    !label.startsWith("xn--") &&
    !/[.#@]/u.test(label) &&
    SPACES_SUBSPACE_LABEL_PATTERN.test(label)
  );
}

/** A Spaces sale-namespace root follows the §2.2 canonical Spaces root rule. */
export function isCanonicalSpacesRootV1(root: string): boolean {
  return parseCanonicalRouteLabelV1("spaces", root).kind === "accepted";
}

export type SpacesHandleNameV1 = Readonly<{
  namespace_root: string;
  handle_label: string;
}>;

/**
 * Renders the protocol and wire identity `<handle_label>@<canonical_root>`.
 * An IDN root keeps its ACE form here (`label@xn--…`); Unicode display is a
 * separate presentation concern. Both labels together stay far below the
 * upstream 255-byte name bound.
 */
export function renderSpacesHandleV1(name: SpacesHandleNameV1): string {
  if (!isCanonicalSpacesSubspaceLabelV1(name.handle_label)) throw new TypeError("invalid_handle");
  if (!isCanonicalSpacesRootV1(name.namespace_root)) {
    throw new TypeError("Invalid canonical Spaces root");
  }
  return `${name.handle_label}@${name.namespace_root}`;
}

/**
 * Exact re-parse of a rendered name. Exactly one `@` separates a canonical
 * subordinate label from a canonical root, and the value must re-render byte
 * for byte. Numeric spaces (`#…`) and multi-label names never parse, so they
 * can never match a Pirate activation.
 */
export function parseSpacesHandleV1(value: string): SpacesHandleNameV1 | null {
  const separator = value.indexOf("@");
  if (separator < 0 || value.includes("@", separator + 1)) return null;
  const name = {
    handle_label: value.slice(0, separator),
    namespace_root: value.slice(separator + 1),
  };
  if (
    !isCanonicalSpacesSubspaceLabelV1(name.handle_label) ||
    !isCanonicalSpacesRootV1(name.namespace_root)
  ) {
    return null;
  }
  return renderSpacesHandleV1(name) === value ? name : null;
}
