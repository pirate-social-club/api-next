/** Provider text is private evidence, never a diagnostic log or public reason. */
export function qencodeFailureEvidence(
  taskToken: string,
  value: unknown,
  objectKey: string,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replaceAll(objectKey, "[source]")
    .replaceAll(encodeURIComponent(objectKey), "[source]")
    .replace(/(?:https?|r2|media):\/\/[^\s<>"']+/giu, "[url]")
    .replace(/https?%3a%2f%2f[^\s<>"']+/giu, "[url]")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
    .replace(/\p{Cc}/gu, " ")
    .trim();
  if (text.length === 0) return undefined;
  // Encode incrementally so truncation cannot split UTF-16 or a percent escape.
  let encoded = "";
  for (const character of new TextDecoder().decode(new TextEncoder().encode(text))) {
    const next = encodeURIComponent(character);
    if (encoded.length + next.length > 384) break;
    encoded += next;
  }
  return `qencode:failure:${taskToken}:${encoded}`;
}
