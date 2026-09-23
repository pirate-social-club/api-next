/**
 * Local rehearsal only: an R2 stand-in for the host's signed S3 requests. It
 * does not verify signatures; it records, per request, the method, key and the
 * access key that signed it, and honours the conditional create the host and
 * the driver use. Objects live in memory; seed files are loaded at start.
 */
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

const port = Number(process.env.REHEARSAL_R2_PORT ?? "55480");
const bucketName = process.env.REHEARSAL_R2_BUCKET ?? "rehearsal-immutable";
const log = process.env.REHEARSAL_R2_LOG ?? "/dev/stdout";
const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
for (const pair of process.argv.slice(2)) {
  const [key, file] = pair.split("=");
  if (!key || !file) continue;
  const bytes = new Uint8Array(await readFile(file));
  objects.set(key, { bytes, etag: createHash("md5").update(bytes).digest("hex") });
}
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname).replace(/^\//u, "");
    const slash = path.indexOf("/");
    const bucket = slash < 0 ? path : path.slice(0, slash);
    const key = slash < 0 ? "" : path.slice(slash + 1);
    const accessKeyId = /Credential=([^/]+)\//u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    const stored = bucket === bucketName ? objects.get(key) : undefined;
    let response: Response;
    if (request.method === "GET" || request.method === "HEAD") {
      response =
        stored === undefined
          ? new Response(null, { status: 404 })
          : new Response(request.method === "HEAD" ? null : stored.bytes, {
              status: 200,
              headers: { etag: `"${stored.etag}"`, "content-length": String(stored.bytes.byteLength) },
            });
    } else if (request.method === "PUT") {
      if (stored !== undefined && request.headers.get("if-none-match") === "*") {
        response = new Response(null, { status: 412 });
      } else {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const etag = createHash("md5").update(bytes).digest("hex");
        objects.set(key, { bytes, etag });
        response = new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
      }
    } else {
      response = new Response(null, { status: 405 });
    }
    await appendFile(log, `${JSON.stringify({ method: request.method, bucket, key, accessKeyId, status: response.status })}\n`);
    return response;
  },
});
console.log(JSON.stringify({ listening: port, bucket: bucketName, seeded: [...objects.keys()] }));
