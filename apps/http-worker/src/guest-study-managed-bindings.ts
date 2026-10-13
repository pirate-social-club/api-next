// Default HTTP composition from actual process bindings; no injected runtime/void callback.
import { guestParticipationRegistry } from "@pirate/contracts";
import {
  type GuestStudyManagedControlPlaneBindings,
  makeGuestStudyManagedControlPlanes,
} from "@pirate/platform-cf/guest-study-managed-control-planes";
import { makeHyperdriveControlPlaneLayer, type HyperdriveConnection } from "@pirate/platform-cf/postgres";
import { Schema } from "effect";
import { workerBackground } from "@pirate/platform-cf/worker-background";
import { Effect } from "effect";
import {
  guestLearningNames,
} from "./guest-authority-controller-composition.ts";
import type { GuestStudyManagedRuntime } from "./guest-study-serving-composition.ts";
import type { OwnerRewardGuestStudyManagedRuntime } from "./owner-reward-guest-study-serving-composition.ts";

export interface GuestStudyManagedBindings extends GuestStudyManagedControlPlaneBindings {
  readonly GUEST_STUDY_SERVING_ENABLED?: string;
  readonly GUEST_STUDY_RUNTIME_CONFIGURATION?: string;
  /** Nonsecret future release selector; absent/false retains canonical practice16. */
  readonly GUEST_STUDY_REWARDS_ENABLED?: string;
  readonly CONTROL_PLANE?:HyperdriveConnection;
  /** Existing trusted server policy also used by jobs. Never body/client config. */
  readonly MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS?: string;
  /** One reviewed exact ordinary product origin. Not CORS lists or request Host. */
  readonly GUEST_STUDY_PRODUCT_ORIGIN?: string;
  /** Existing provider/storage bindings only; no new secret is introduced. */
  readonly ELEVENLABS_API_KEY?: string;
  readonly LEARNER_AUDIO?: GuestStudyManagedRuntime["bucket"];
  readonly STUDY_SPOKEN_RERECORD_ENABLED?: string;
}
function productOrigin(value: string | undefined): string {
  try {
    if (value === undefined || value.length > 512) throw new Error("origin missing");
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== value ||
      parsed.hostname.includes("*") ||
      parsed.username !== "" ||
      parsed.password !== ""
    )
      throw new Error("origin invalid");
    return value;
  } catch {
    throw new Error("Managed Guest Study product origin unavailable");
  }
}
export function makeDefaultGuestStudyManagedRuntime(
  bindings: GuestStudyManagedBindings,
  environment: string,
): GuestStudyManagedRuntime | null {
  const enabled = bindings.GUEST_STUDY_SERVING_ENABLED;
  // No connection/key/storage getters, Layers or provider calls on the inert path.
  if (enabled === undefined || enabled === "false") return null;
  if (enabled !== "true" || !["development", "staging", "test"].includes(environment))
    throw new Error("Guest Study serving requires explicit nonproduction admission");
  for (const name of guestLearningNames)
    if (guestParticipationRegistry[name].implementation === "disabled")
      throw new Error("Guest Study implementation declarations remain disabled");
  // Practice transport still excludes accounting names and native profile
  // verification rejects every unexpected effective financial privilege.
  const ordinaryProductOrigin = productOrigin(bindings.GUEST_STUDY_PRODUCT_ORIGIN);
  const bucket = bindings.LEARNER_AUDIO;
  if (
    bucket === undefined ||
    typeof bucket.put !== "function" ||
    typeof bucket.delete !== "function"
  )
    throw new Error("Managed Guest Study learner audio binding unavailable");
  const controlPlanes = makeGuestStudyManagedControlPlanes(bindings);
  const currentKey = bindings.ELEVENLABS_API_KEY;
  // The actual invoking SDK exposes available=false for this absent/malformed
  // value. It does not dispatch/rebill while continuing an original saved CP.
  const apiKey =
    currentKey === undefined || currentKey.length === 0 || currentKey.trim() !== currentKey
      ? ""
      : currentKey;
  return Object.freeze({
    ...controlPlanes,
    bucket,
    transcriber: Object.freeze({ apiKey }), // Actual retained ElevenLabs adapter/global fetch.
    ordinaryProductOrigin,
    clock: { now: Effect.sync(() => Date.now()) },
    ids: { next: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")) },
    nowMilliseconds: () => Date.now(),
    retryAfterSeconds: 2,
    rerecordEnabled: bindings.STUDY_SPOKEN_RERECORD_ENABLED === "true",
    // index.ts wraps real HTTP fetch in workerBackground.run(ctx.waitUntil,...).
    // Resolve that actual request scope at invocation, never cache a prior ctx.
    // A promise here is already durable/original; absence cannot invent abort.
    retainTask: (task: Promise<unknown>) => {
      workerBackground.defer(() => task);
    },
  });
}

export function ownerFinancialGuestStudySelected(bindings:GuestStudyManagedBindings,environment:string):boolean {
 const enabled=bindings.GUEST_STUDY_REWARDS_ENABLED;
 if(enabled===undefined || enabled==="false") return false;
 if(enabled!=="true" || !["development","staging","test"].includes(environment))
  throw new Error("Guest financial serving requires explicit nonproduction admission");
 if(bindings.GUEST_STUDY_SERVING_ENABLED!=="true")
  throw new Error("Financial Guest Study requires explicitly enabled learning composition");
 return true;
}
export function makeDefaultOwnerRewardGuestStudyManagedRuntime(bindings:GuestStudyManagedBindings,
 environment:string):OwnerRewardGuestStudyManagedRuntime|null {
 if(!ownerFinancialGuestStudySelected(bindings,environment)) return null;
 const actual=makeDefaultGuestStudyManagedRuntime(bindings,environment);
 if(actual===null) throw new Error("Financial Guest Study managed bindings unavailable");
 const raw=bindings.MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS;
 // Missing/malformed policy has no NEW financial quote; original recovery does
 // not require it. This is not a server default or client-provided number.
 const purchaseSafetyMarginSeconds=raw!==undefined && /^[1-9][0-9]{0,3}$/u.test(raw)
  && Number(raw)<=3600?Number(raw):null;
 const core=Schema.decodeUnknownSync(Schema.Struct({connectionString:Schema.NonEmptyString}))(bindings.CONTROL_PLANE);
 if(core.connectionString.trim()!==core.connectionString) throw new Error("Ordinary Account database binding unavailable");
 const distinct=[core.connectionString,bindings.GUEST_STUDY_PUBLIC_READ?.connectionString,
  bindings.GUEST_STUDY_CONTROLLED_LEARNING?.connectionString,bindings.GUEST_STUDY_CRON?.connectionString,
  bindings.GUEST_STUDY_READINESS_OBSERVER?.connectionString];
 if(new Set(distinct).size!==5) throw new Error("Financial principals must use five distinct bindings");
 const ordinaryAccount=makeHyperdriveControlPlaneLayer(core,{connectTimeoutMs:3000,statementTimeoutMs:2000,closeTimeoutMs:2000});
 return Object.freeze({...actual,purchaseSafetyMarginSeconds,ordinaryAccount});
}
