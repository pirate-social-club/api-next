const COMMITMENT_PATH = /^\/megapot\/commitments\/(megapot_commitment_[0-9a-f]{64}\.json)$/u;

export interface MegapotPublicCommitmentObject {
  readonly body: ReadableStream;
  readonly httpEtag?: string;
}

export interface MegapotPublicCommitmentBucket {
  readonly get: (key: string) => Promise<MegapotPublicCommitmentObject | null>;
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/** Serves immutable, intentionally public commitment evidence from the staging R2 bucket. */
export async function handleMegapotPublicCommitment(
  request: Request,
  bucket: MegapotPublicCommitmentBucket | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const match = COMMITMENT_PATH.exec(url.pathname);
  if (match === null || url.search.length > 0 || url.hash.length > 0) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        allow: "GET, HEAD",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (bucket === undefined) return notFound();

  const object = await bucket.get(`megapot/commitments/${match[1]}`);
  if (object === null) return notFound();
  const headers = new Headers({
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  if (object.httpEtag !== undefined) headers.set("etag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}
