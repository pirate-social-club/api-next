import {
  bytesToHex,
  type CleanupEvidence,
  cleanupExactObject,
  type R2BindingSealAttempt,
  R2BindingSealFailure,
  type R2ObjectIdentity,
  type R2SealBucket,
  sealR2Upload,
} from "./binding-seal";

const ACKNOWLEDGEMENT = "ACKNOWLEDGE_DISPOSABLE_R2_BINDING_PROOF_V1";
const CONTENT_TYPE = "audio/mpeg";
const MAX_REQUEST_BYTES = 2_048;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX_PATTERN = /^[a-z0-9][a-z0-9/_-]{0,79}$/;

type ProofScenario =
  | "success"
  | "source_precondition_failed"
  | "destination_conflict"
  | "expectation_mismatch";

interface ProofRequest {
  readonly acknowledgement: typeof ACKNOWLEDGEMENT;
  readonly run_id: string;
  readonly scenario: ProofScenario;
}

interface AuditRequest {
  readonly acknowledgement: typeof ACKNOWLEDGEMENT;
}

interface ObjectEvidence {
  readonly key: string;
  readonly version: string;
  readonly etag: string;
  readonly size_bytes: number;
  readonly sha256: string | null;
}

interface ProofCleanupCandidate {
  readonly key: string;
  readonly ownershipMarker: string;
  readonly allowedPayloads: readonly Uint8Array[];
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_REQUEST_BYTES) {
    throw new Error("request_too_large");
  }
  if (request.body === null) throw new Error("request_body_missing");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel("request_too_large");
      throw new Error("request_too_large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function parseProofRequest(value: unknown): ProofRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "acknowledgement,run_id,scenario") throw new Error("invalid_request");
  if (record.acknowledgement !== ACKNOWLEDGEMENT) throw new Error("acknowledgement_required");
  if (typeof record.run_id !== "string" || !RUN_ID_PATTERN.test(record.run_id)) {
    throw new Error("invalid_run_id");
  }
  if (
    record.scenario !== "success" &&
    record.scenario !== "source_precondition_failed" &&
    record.scenario !== "destination_conflict" &&
    record.scenario !== "expectation_mismatch"
  ) {
    throw new Error("invalid_scenario");
  }
  return {
    acknowledgement: record.acknowledgement,
    run_id: record.run_id,
    scenario: record.scenario,
  };
}

function parseAuditRequest(value: unknown): AuditRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).join(",") !== "acknowledgement" ||
    record.acknowledgement !== ACKNOWLEDGEMENT
  ) {
    throw new Error("acknowledgement_required");
  }
  return { acknowledgement: ACKNOWLEDGEMENT };
}

async function tokenMatches(request: Request, expectedToken: string): Promise<boolean> {
  if (typeof expectedToken !== "string" || expectedToken.length < 20) return false;
  const provided = request.headers.get("authorization") ?? "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${expectedToken}`)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function objectEvidence(object: R2ObjectIdentity | undefined): ObjectEvidence | null {
  if (object === undefined) return null;
  return {
    key: object.key,
    version: object.version,
    etag: object.etag,
    size_bytes: object.size,
    sha256: object.checksums.sha256 === undefined ? null : bytesToHex(object.checksums.sha256),
  };
}

function fixedPayload(runId: string, variant = "original"): Uint8Array {
  return new TextEncoder().encode(`r2-binding-proof-v1:${runId}:${variant}`);
}

async function digest(bytes: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", bytes);
}

async function cleanupProofCandidate(
  bucket: R2Bucket,
  candidate: ProofCleanupCandidate,
): Promise<CleanupEvidence> {
  let current: R2Object | null;
  try {
    current = await bucket.head(candidate.key);
  } catch {
    return { outcome: "retained_head_failed" };
  }
  if (current === null) return { outcome: "already_missing" };
  const checksum = current.checksums.sha256;
  if (
    current.customMetadata?.["media-seal-owner"] !== candidate.ownershipMarker ||
    current.httpMetadata?.contentType !== CONTENT_TYPE ||
    checksum === undefined
  ) {
    return { outcome: "retained_identity_mismatch" };
  }
  const actualSha256 = bytesToHex(checksum);
  const allowed = await Promise.all(
    candidate.allowedPayloads.map(async (payload) => ({
      size: payload.byteLength,
      sha256: bytesToHex(await digest(payload)),
    })),
  );
  if (
    !allowed.some((expected) => expected.size === current.size && expected.sha256 === actualSha256)
  ) {
    return { outcome: "retained_identity_mismatch" };
  }
  return cleanupExactObject(bindingAdapter(bucket), current);
}

async function putSetupObject(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  ownershipMarker: string,
): Promise<R2Object> {
  const written = await bucket.put(key, bytes, {
    onlyIf: new Headers({ "if-none-match": "*" }),
    httpMetadata: { contentType: CONTENT_TYPE },
    customMetadata: { "media-seal-owner": ownershipMarker },
    sha256: await digest(bytes),
  });
  if (written === null) throw new Error("setup_destination_conflict");
  return written;
}

function bindingAdapter(bucket: R2Bucket): R2SealBucket {
  return {
    head: (key) => bucket.head(key),
    get: (key, options) => bucket.get(key, options),
    put: (key, value, options) => bucket.put(key, value, options),
    delete: (key) => bucket.delete(key),
  };
}

function overwriteBeforeGetAdapter(
  bucket: R2Bucket,
  sourceKey: string,
  ownershipMarker: string,
  onOverwrite: (identity: R2Object) => void,
): R2SealBucket {
  let overwritten = false;
  return {
    ...bindingAdapter(bucket),
    get: async (key, options) => {
      if (!overwritten && key === sourceKey) {
        overwritten = true;
        const replacement = fixedPayload(ownershipMarker, "overwritten");
        const identity = await bucket.put(key, replacement, {
          httpMetadata: { contentType: CONTENT_TYPE },
          customMetadata: { "media-seal-owner": ownershipMarker },
          sha256: await digest(replacement),
        });
        onOverwrite(identity);
      }
      return bucket.get(key, options);
    },
  };
}

async function runProof(env: Env, proof: ProofRequest): Promise<Response> {
  if (!PREFIX_PATTERN.test(env.PROOF_PREFIX)) {
    return jsonResponse({ version: "r2-binding-proof-v1", outcome: "invalid_private_prefix" }, 500);
  }
  const startedAt = new Date().toISOString();
  const baseKey = `${env.PROOF_PREFIX}/${proof.run_id}`;
  const sourceKey = `${baseKey}/ingress`;
  const destinationKey = `${baseKey}/sealed`;
  const ownershipMarker = `r2-binding-proof:${proof.run_id}`;
  const sourceBytes = fixedPayload(proof.run_id);
  const overwrittenSourceBytes = fixedPayload(ownershipMarker, "overwritten");
  const conflictBytes = fixedPayload(proof.run_id, "conflict");
  const sourceSha256 = await digest(sourceBytes);

  const [sourceBefore, destinationBefore] = await Promise.all([
    env.PROOF_BUCKET.head(sourceKey),
    env.PROOF_BUCKET.head(destinationKey),
  ]);
  if (sourceBefore !== null || destinationBefore !== null) {
    return jsonResponse(
      {
        version: "r2-binding-proof-v1",
        run_id: proof.run_id,
        scenario: proof.scenario,
        outcome: "unsafe_preexisting_object",
      },
      409,
    );
  }

  let originalSource: R2Object | undefined;
  let currentSource: R2Object | undefined;
  let seededDestination: R2Object | undefined;
  let attempt: R2BindingSealAttempt | undefined;
  let failure: R2BindingSealFailure | undefined;
  let runnerFailure = false;
  try {
    originalSource = await putSetupObject(
      env.PROOF_BUCKET,
      sourceKey,
      sourceBytes,
      ownershipMarker,
    );
    currentSource = originalSource;
    if (proof.scenario === "destination_conflict") {
      seededDestination = await putSetupObject(
        env.PROOF_BUCKET,
        destinationKey,
        conflictBytes,
        ownershipMarker,
      );
    }

    const bucket =
      proof.scenario === "source_precondition_failed"
        ? overwriteBeforeGetAdapter(env.PROOF_BUCKET, sourceKey, ownershipMarker, (identity) => {
            currentSource = identity;
          })
        : bindingAdapter(env.PROOF_BUCKET);
    attempt = await sealR2Upload(bucket, {
      sourceKey,
      destinationKey,
      immutableRef: `proof:${proof.run_id}`,
      expectedSizeBytes: sourceBytes.byteLength,
      expectedContentType: CONTENT_TYPE,
      expectedSha256:
        proof.scenario === "expectation_mismatch" ? "f".repeat(64) : bytesToHex(sourceSha256),
      ownershipMarker,
    });
  } catch (error) {
    if (error instanceof R2BindingSealFailure) failure = error;
    else runnerFailure = true;
  }

  const destinationIdentity = attempt?.destinationIdentity ?? seededDestination;
  const destinationCleanup =
    destinationIdentity === undefined
      ? await cleanupProofCandidate(env.PROOF_BUCKET, {
          key: destinationKey,
          ownershipMarker,
          allowedPayloads: [sourceBytes, conflictBytes],
        })
      : await cleanupExactObject(bindingAdapter(env.PROOF_BUCKET), destinationIdentity);
  const sourceCleanup =
    currentSource === undefined
      ? await cleanupProofCandidate(env.PROOF_BUCKET, {
          key: sourceKey,
          ownershipMarker,
          allowedPayloads: [sourceBytes, overwrittenSourceBytes],
        })
      : await cleanupExactObject(bindingAdapter(env.PROOF_BUCKET), currentSource);
  const [sourceAfter, destinationAfter] = await Promise.all([
    env.PROOF_BUCKET.head(sourceKey),
    env.PROOF_BUCKET.head(destinationKey),
  ]);
  const finishedAt = new Date().toISOString();

  return jsonResponse(
    {
      version: "r2-binding-proof-v1",
      target: env.PROOF_TARGET_LABEL,
      run_id: proof.run_id,
      scenario: proof.scenario,
      started_at: startedAt,
      finished_at: finishedAt,
      result: attempt?.result ?? null,
      closed_failure: failure?.code ?? (runnerFailure ? "proof_runner_failure" : null),
      seal_cleanup: attempt?.cleanup ?? failure?.cleanup ?? { outcome: "not_required" },
      source: objectEvidence(originalSource),
      destination: objectEvidence(destinationIdentity),
      final_cleanup: {
        source: sourceCleanup,
        destination: destinationCleanup,
        source_residual: sourceAfter !== null,
        destination_residual: destinationAfter !== null,
      },
      cleanup_complete: sourceAfter === null && destinationAfter === null,
    },
    runnerFailure ? 500 : 200,
  );
}

async function auditProofPrefix(env: Env): Promise<Response> {
  if (!PREFIX_PATTERN.test(env.PROOF_PREFIX)) {
    return jsonResponse({ version: "r2-binding-proof-v1", outcome: "invalid_private_prefix" }, 500);
  }

  let cursor: string | undefined;
  let objectCount = 0;
  let totalBytes = 0;
  let pages = 0;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const listed = await env.PROOF_BUCKET.list({
      prefix: `${env.PROOF_PREFIX}/`,
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages += 1;
    objectCount += listed.objects.length;
    totalBytes += listed.objects.reduce((sum, object) => sum + object.size, 0);
    if (!listed.truncated) {
      return jsonResponse({
        version: "r2-binding-proof-v1",
        outcome: "audit_complete",
        scope: "configured_proof_prefix",
        object_count: objectCount,
        total_bytes: totalBytes,
        pages,
        complete: true,
      });
    }
    if (typeof listed.cursor !== "string" || listed.cursor.length === 0) {
      return jsonResponse(
        {
          version: "r2-binding-proof-v1",
          outcome: "closed_audit_cursor_missing",
          complete: false,
        },
        500,
      );
    }
    cursor = listed.cursor;
  }

  return jsonResponse(
    {
      version: "r2-binding-proof-v1",
      outcome: "closed_audit_page_limit",
      complete: false,
    },
    500,
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || (url.pathname !== "/run" && url.pathname !== "/audit")) {
      return jsonResponse({ outcome: "not_found" }, 404);
    }
    if (!(await tokenMatches(request, env.PROOF_RUN_TOKEN))) {
      return jsonResponse({ outcome: "unauthorized" }, 401);
    }
    if (url.pathname === "/audit") {
      try {
        parseAuditRequest(await readBoundedJson(request));
      } catch {
        return jsonResponse({ outcome: "invalid_request" }, 400);
      }
      try {
        return await auditProofPrefix(env);
      } catch {
        return jsonResponse(
          {
            version: "r2-binding-proof-v1",
            outcome: "closed_internal_failure",
            failure_class: "proof_audit_failure",
          },
          500,
        );
      }
    }
    let proof: ProofRequest;
    try {
      proof = parseProofRequest(await readBoundedJson(request));
    } catch {
      return jsonResponse({ outcome: "invalid_request" }, 400);
    }
    try {
      return await runProof(env, proof);
    } catch (error) {
      return jsonResponse(
        {
          version: "r2-binding-proof-v1",
          run_id: proof.run_id,
          scenario: proof.scenario,
          outcome: "closed_internal_failure",
          failure_class:
            error instanceof R2BindingSealFailure ? "binding_seal_failure" : "proof_runner_failure",
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
