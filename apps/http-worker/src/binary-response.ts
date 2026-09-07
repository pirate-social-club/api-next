import { type EndpointDefinition, InternalError } from "@pirate/contracts";

/** Called only after the ordinary router's authorization and handler execution.
 * A tagged handler result carries bytes, never an arbitrary Response escape hatch.
 */
export async function binaryEndpointResponse(
  endpoint: EndpointDefinition,
  body: unknown,
  status: number,
  headers: Headers,
): Promise<Response> {
  const fail = () => new InternalError({ message: "Invalid binary endpoint response" });
  try {
    const representation = endpoint.responseRepresentation;
    if (representation === undefined) throw fail();
    const statuses = Array.isArray(endpoint.successStatus) ? endpoint.successStatus : [];
    if (!statuses.includes(status)) throw fail();
    const etag = headers.get("etag");
    if (etag === null || !/^"[\x21\x23-\x7e]{1,128}"$/u.test(etag)) throw fail();
    const contentType = headers.get("content-type");
    if (contentType !== null && contentType !== representation.contentType) throw fail();
    if (headers.has("content-encoding") || headers.has("location")) throw fail();
    const outputHeaders = new Headers({
      "cache-control": representation.cacheControl,
      etag,
      "x-content-type-options": "nosniff",
    });
    const requestId = headers.get("x-request-id");
    if (requestId !== null) outputHeaders.set("x-request-id", requestId);
    if (status === 304) {
      if (body !== null) throw fail();
      return new Response(null, { status, headers: outputHeaders });
    }
    if (status !== 200 || !(body instanceof ReadableStream)) throw fail();
    outputHeaders.set("content-type", representation.contentType);
    return new Response(body, { status, headers: outputHeaders });
  } catch (error) {
    if (body instanceof ReadableStream) {
      try {
        await body.cancel();
      } catch {
        // Cancellation failure must not replace the redacted protocol failure.
      }
    }
    throw error;
  }
}
