import {
  type CommunityModerationStoreService,
  canonicalBodyHash,
  replayLegacyCommunityModerationAction,
} from "@pirate/application/use-cases/content/community-moderation-runtime";
import { BadRequest, Conflict } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import type { BeforeDecodeArgs } from "./transport.ts";

const MAX_LEGACY_ACTION_BYTES = 4_096;
const LegacyActionBodyV1 = Schema.Struct({
  idempotency_key: Schema.String,
  action: Schema.Literals(["approve", "dismiss", "hide", "remove", "restore"]),
});
type LegacyActionBody = Schema.Schema.Type<typeof LegacyActionBodyV1>;

type CompatibilityRequest = BeforeDecodeArgs["request"];

const legacyCaseRef = (request: CompatibilityRequest): string | null => {
  const match = /^\/(?:api\/)?moderation\/cases\/([^/]+)\/actions$/u.exec(
    new URL(request.url).pathname,
  );
  if (match?.[1] === undefined) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

const readLegacyBody = async (request: CompatibilityRequest): Promise<LegacyActionBody | null> => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return null;
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_LEGACY_ACTION_BYTES)
  ) {
    return null;
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LEGACY_ACTION_BYTES) return null;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  try {
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return Schema.decodeUnknownSync(LegacyActionBodyV1, { onExcessProperty: "error" })(decoded);
  } catch {
    return null;
  }
};

export const makeLegacyModerationActionCompatibility =
  (moderationStore: CommunityModerationStoreService) =>
  async ({ bindingName, principal, request }: BeforeDecodeArgs): Promise<Response | undefined> => {
    if (bindingName !== "ModerateCaseAction") return undefined;
    if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
      return undefined;
    }
    const caseRef = legacyCaseRef(request);
    if (caseRef === null) return undefined;
    const body = await readLegacyBody(request);
    if (body === null) return undefined;
    if (body.idempotency_key.trim() === "") {
      throw new BadRequest({ message: "An idempotency key is required" });
    }
    const requestHash = await Effect.runPromise(
      canonicalBodyHash({
        endpoint: "POST /moderation/cases/:caseRef/actions",
        case_ref: caseRef,
        body,
      }),
    );
    const replay = await Effect.runPromise(
      replayLegacyCommunityModerationAction(
        {
          caseRef,
          actor: { kind: principal.kind, userId: principal.subject },
          idempotencyKey: body.idempotency_key,
          requestHash,
        },
        { moderationStore },
      ),
    );
    if (replay === null) {
      throw new Conflict({
        message: "Legacy moderation actions are no longer accepted",
        details: { reason_code: "contract_version_unsupported" },
      });
    }
    return new Response(replay.responseBytes.slice().buffer, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/json; charset=utf-8",
      },
    });
  };
