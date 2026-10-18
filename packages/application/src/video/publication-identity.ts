/** Fixed, server-owned v1 identity. Never use a retry, approval, or intent as a salt. */
export async function videoPublicationPostId(
  input: Readonly<{
    submissionId: string;
    operationId: string;
    postId: string | null;
  }>,
): Promise<string> {
  if (input.postId !== null) return input.postId;
  const encoder = new TextEncoder();
  const keys = [input.submissionId, input.operationId].map((key) => {
    if (
      !key ||
      key.trim() !== key ||
      key.includes("\u0000") ||
      new TextDecoder().decode(encoder.encode(key)) !== key
    )
      throw new Error("Invalid durable video publication key");
    return encoder.encode(key);
  });
  const prefix = encoder.encode("pirate/video-publication-post-id/v1\u0000");
  const bytes = new Uint8Array(prefix.length + keys.reduce((n, key) => n + 4 + key.length, 0));
  bytes.set(prefix);
  let offset = prefix.length;
  for (const key of keys) {
    new DataView(bytes.buffer).setUint32(offset, key.length, false);
    bytes.set(key, offset + 4);
    offset += 4 + key.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `post-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
