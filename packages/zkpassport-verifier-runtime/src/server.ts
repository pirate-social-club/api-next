import { handleZkPassportVerifierRequest } from "./index.ts";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const port = positiveInteger(process.env.ZKPASSPORT_VERIFIER_PORT ?? process.env.PORT, 8794);
const sharedSecret = process.env.ZKPASSPORT_VERIFIER_SHARED_SECRET?.trim() ?? "";
const maxBodyBytes = positiveInteger(
  process.env.ZKPASSPORT_VERIFIER_MAX_BODY_BYTES,
  10 * 1024 * 1024,
);
const writingDirectory = process.env.ZKPASSPORT_VERIFIER_WRITING_DIRECTORY?.trim() || "/tmp";

const server = Bun.serve({
  port,
  hostname: process.env.HOST?.trim() || "127.0.0.1",
  fetch: (request) =>
    handleZkPassportVerifierRequest(request, { sharedSecret, maxBodyBytes, writingDirectory }),
});

console.log(
  JSON.stringify({
    event: "zkpassport.verifier.started",
    service: "zkpassport-verifier",
    port: server.port,
  }),
);
