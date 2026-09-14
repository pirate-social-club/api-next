/**
 * One object identity both storage APIs agree on.
 *
 * The Workers R2 binding reports an unquoted ETag; the S3 HTTP response
 * carries the same tag quoted, and possibly weak-prefixed. Sealing records
 * this normalized form for a song-video master, and the source gateway
 * compares it against the bucket object, so a master written by the host
 * resolves from a Worker and the reverse, without assuming the two APIs'
 * version fields are the same thing.
 */
export function normalizeObjectEtag(etag: string): string {
  const trimmed = etag.trim();
  const unquoted = trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
  return unquoted.replace(/^"/u, "").replace(/"$/u, "");
}

/**
 * How a sealed object's recorded identity is validated downstream. An ordinary
 * upload is identified by the store's upload version; a rendered master is
 * identified by its normalized content ETag, because the two storage APIs
 * expose different version fields for it.
 */
export type MediaObjectIdentityKind = "upload_version" | "content_etag";
