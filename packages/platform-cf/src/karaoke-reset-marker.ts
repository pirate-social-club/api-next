import { Schema } from "effect";

export const KARAOKE_RESET_MARKER_KEY = "karaoke:staging-reset-marker:v1";

const Identity = Schema.Struct({
  namespaceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  objectId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  generation: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u)),
});
const State = Schema.Literals(["active", "retired"]);
const Marker = Schema.Struct({
  version: Schema.Literal(1),
  ...Identity.fields,
  state: State,
});

export type KaraokeResetIdentity = typeof Identity.Type;
export type KaraokeResetMarker = typeof Marker.Type;
export type KaraokeResetInspection =
  | Readonly<{ state: "absent" | "invalid" }>
  | Readonly<{ state: "active" | "retired"; marker: KaraokeResetMarker }>;

/** Presence of any invalid value is a fence, never an absent-marker fallback. */
export function inspectKaraokeResetMarker(
  stored: unknown,
  identity: KaraokeResetIdentity,
): KaraokeResetInspection {
  if (stored === undefined) return { state: "absent" };
  try {
    const marker = Schema.decodeUnknownSync(Marker, { onExcessProperty: "error" })(stored);
    if (
      marker.namespaceId !== identity.namespaceId ||
      marker.objectId !== identity.objectId ||
      marker.generation !== identity.generation
    ) {
      return { state: "invalid" };
    }
    return { state: marker.state, marker: Object.freeze(marker) };
  } catch {
    return { state: "invalid" };
  }
}

/** Pure transition only; caller must authenticate, serialize and persist before effects. */
export function transitionKaraokeResetMarker(
  stored: unknown,
  identity: KaraokeResetIdentity,
  requestedState: "active" | "retired",
): KaraokeResetMarker {
  let command: KaraokeResetMarker;
  try {
    command = Schema.decodeUnknownSync(Marker, { onExcessProperty: "error" })({
      version: 1,
      ...identity,
      state: requestedState,
    });
  } catch {
    throw new Error("karaoke_reset_invalid_command");
  }
  const current = inspectKaraokeResetMarker(stored, identity);
  if (current.state === "invalid") throw new Error("karaoke_reset_invalid_marker");
  if (current.state === "retired" && requestedState !== "retired") {
    throw new Error("karaoke_reset_retired");
  }
  if (current.state === "absent" && requestedState === "retired") {
    throw new Error("karaoke_reset_not_installed");
  }
  return Object.freeze(command);
}
