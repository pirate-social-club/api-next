/** Reads only a derived-bucket object identity; never follows a provider URL. */
export function makeVideoStageArtifactHead(
  bucket: Readonly<{
    head: (key: string) => Promise<Readonly<{
      size: number;
      customMetadata?: Readonly<Record<string, string>>;
      httpMetadata?: Readonly<{ contentType?: string }>;
    }> | null>;
  }>,
) {
  return async (artifactRef: string) => {
    const prefix = "media://derived/";
    if (!artifactRef.startsWith(prefix)) throw new Error("invalid derived artifact reference");
    const key = artifactRef.slice(prefix.length);
    if (!/^[A-Za-z0-9_./:-]+$/u.test(key) || key.split("/").includes("..") || key.startsWith("/"))
      throw new Error("invalid derived artifact reference");
    const object = await bucket.head(key);
    if (object === null) return null;
    return {
      canonicalSha256: object.customMetadata?.sha256 ?? "",
      sizeBytes: object.size,
      contentType: object.httpMetadata?.contentType ?? "",
    };
  };
}
