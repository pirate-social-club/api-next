import type { GuestResourceAdmissionPolicy } from "@pirate/application";
import { GuestStudyPreparedContentV1 } from "@pirate/contracts";
import { readGuestResourceAdmissionPolicy } from "@pirate/platform-cf/guest-resource-policy";
import { Schema } from "effect";

export type GuestStudyRuntimeConfiguration = Readonly<{
  policy: GuestResourceAdmissionPolicy;
  disclosure: GuestStudyPreparedContentV1["disclosure"];
}>;
const Configuration = Schema.Struct({
  policy: Schema.Unknown,
  disclosure: GuestStudyPreparedContentV1.fields.disclosure,
});

/** A reviewed release supplies this complete nonsecret configuration. Missing
 * or invalid configuration conveys no paid capability or invented disclosure.
 * Parsing never logs the binding or substitutes numerical defaults.
 */
export function readGuestStudyRuntimeConfiguration(
  binding: string | undefined,
): GuestStudyRuntimeConfiguration | null {
  if (binding === undefined || new TextEncoder().encode(binding).byteLength > 16_384) return null;
  try {
    const configuration = Schema.decodeUnknownSync(Configuration, { onExcessProperty: "error" })(
      JSON.parse(binding),
    );
    const policy = readGuestResourceAdmissionPolicy(configuration.policy);
    if (policy === null) return null;
    return Object.freeze({
      policy: Object.freeze(policy),
      disclosure: Object.freeze(configuration.disclosure),
    });
  } catch {
    return null;
  }
}

/** Inputs belong to the authenticated product-origin resolver and existing
 * Cloudflare edge transport metadata. Never call with body/query-selected IPs
 * or origins. A forwarded request may supply the gateway edge address rather
 * than the browser address; that conservative bucket is not browser identity.
 */
export async function makeGuestStudyTrustedEdge(
  exactProductOrigin: string,
  edgeClientIp: string | undefined,
): Promise<Readonly<{ kind: "trusted_edge"; fingerprint: string }> | null> {
  if (
    edgeClientIp === undefined ||
    edgeClientIp.length === 0 ||
    edgeClientIp.length > 128 ||
    !/^[0-9a-fA-F:.]+$/u.test(edgeClientIp)
  )
    return null;
  try {
    const origin = new URL(exactProductOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== exactProductOrigin ||
      origin.hostname.includes("*")
    )
      return null;
    const bytes = new TextEncoder().encode(
      JSON.stringify(["guest_study_trusted_application_edge_v1", exactProductOrigin, edgeClientIp]),
    );
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Object.freeze({
      kind: "trusted_edge",
      fingerprint: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    });
  } catch {
    return null;
  }
}
