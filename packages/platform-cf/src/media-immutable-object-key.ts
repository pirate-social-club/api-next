const IMMUTABLE_REFERENCE_PREFIX = "media://immutable/";

/** Translate one persisted logical identity into the fixed-template R2 key. */
export function mediaProcessingPhysicalObjectKey(reference: string): string {
  if (!reference.startsWith(IMMUTABLE_REFERENCE_PREFIX)) {
    throw new TypeError("invalid immutable media reference");
  }
  const suffix = reference.slice(IMMUTABLE_REFERENCE_PREFIX.length);
  if (
    suffix.length === 0 ||
    suffix.length > 768 ||
    suffix.startsWith("/") ||
    suffix.includes("\\") ||
    suffix.split("/").includes("..")
  ) {
    throw new TypeError("invalid immutable media reference");
  }
  return `immutable/${suffix}`;
}

export function mediaImmutableReferenceFromPhysicalKey(key: string): string {
  if (!key.startsWith("immutable/")) throw new TypeError("invalid immutable object key");
  const reference = `${IMMUTABLE_REFERENCE_PREFIX}${key.slice("immutable/".length)}`;
  if (mediaProcessingPhysicalObjectKey(reference) !== key)
    throw new TypeError("invalid immutable object key");
  return reference;
}
