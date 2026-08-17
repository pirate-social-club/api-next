import {
  type ProviderSessionStart,
  type VerificationProviderAdapter,
  type VerificationProviderCallbackInput,
  type VerificationProviderCallbackResolution,
  type VerificationProviderCompleteInput,
  type VerificationProviderFailure,
  VerificationProviderInvalidResponse,
  VerificationProviderMisconfigured,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
} from "@pirate/application/verification";
import {
  type Assertion,
  type CanonicalClaimIdentifier,
  type CanonicalIsoInstant,
  type EvidenceBundle,
  type Iso3166Alpha2,
  type ProofProviderManifest,
  type ProofSession,
  type ProviderConfigurationRef,
  Sha256Hex,
  type SubjectScope,
  type VerificationRequirement,
} from "@pirate/domain/verification";
import type { AttestationId, VerificationConfig } from "@selfxyz/core";
import { Effect, Option, Schema } from "effect";

/**
 * Self Pass is deliberately separate from the exploratory Self Enterprise
 * adapter.  It is the open-source, dynamically compiled SelfBackendVerifier
 * ceremony that runs inside the HTTP Worker.
 */
export const SELF_PASS_PROVIDER_ID = "self.pass" as const;
export const SELF_PASS_PROTOCOL_VERSION = "self-pass-v1" as const;
export const SELF_PASS_PRESENTATION_PROTOCOL = "self" as const;
export const SELF_PASS_PRESENTATION_VERSION = "2" as const;
export const SELF_PASS_RP_SCOPE = "pirate-social" as const;
export const SELF_PASS_CONFIGURATION: ProviderConfigurationRef = {
  kind: "dynamic",
  reference: "self.pass.disclosure-compiler",
  version: "1.2.0-beta.1",
};

/** Self Pass cannot prove face match or liveness, so holder binding is not claimed. */
const SELF_PASS_CLAIMS = [
  "age.minimum",
  "credential.subject_unique",
  "document.valid",
  "gender.marker",
  "nationality.allowed",
] as const satisfies readonly CanonicalClaimIdentifier[];

export const SELF_PASS_MANIFEST: Schema.Schema.Type<typeof ProofProviderManifest> = {
  provider_id: SELF_PASS_PROVIDER_ID,
  manifest_version: "1",
  protocol_versions: [SELF_PASS_PROTOCOL_VERSION],
  environments: ["test", "development", "staging", "production"],
  supported_methods: ["document"],
  claim_ids: [...SELF_PASS_CLAIMS],
  claim_capabilities: SELF_PASS_CLAIMS.map((claim_id) => ({
    claim_id,
    request_modes: ["dynamic" as const],
  })),
  presentation_kinds: ["embedded_sdk"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

type SelfCoreModule = typeof import("@selfxyz/core");
type SelfVerifier = InstanceType<SelfCoreModule["SelfBackendVerifier"]>;
export type SelfPassProof = Parameters<SelfVerifier["verify"]>[1];
export type SelfPassPublicSignals = Parameters<SelfVerifier["verify"]>[2];
export type SelfPassVerificationResult = Awaited<ReturnType<SelfVerifier["verify"]>>;

/**
 * The production seam is the actual module returned by the literal dynamic
 * import. Tests inject a structurally identical seam so no global SDK mock is
 * needed and the constructor/verify call remains exactly the SDK call.
 */
export type SelfPassSdk = Readonly<{
  readonly AllIds: SelfCoreModule["AllIds"];
  readonly DefaultConfigStore: SelfCoreModule["DefaultConfigStore"];
  readonly SelfBackendVerifier: SelfCoreModule["SelfBackendVerifier"];
}>;

export type SelfPassClock = Readonly<{
  readonly now: () => CanonicalIsoInstant;
  readonly expiresAt: (now: CanonicalIsoInstant) => CanonicalIsoInstant;
}>;

export type SelfPassIdentifierKind =
  | "session"
  | "bundle"
  | "receipt"
  | "subject"
  | "binding"
  | "assertion";

export type SelfPassIdentifiers = Readonly<{
  readonly next: (kind: SelfPassIdentifierKind) => string;
}>;

export type SelfPassDigest = Readonly<{
  readonly digest: (value: string) => Effect.Effect<string, VerificationProviderFailure>;
}>;

export type SelfPassAdapterOptions = Readonly<{
  /** Public HTTPS origin of this Worker, without the callback path. */
  readonly callback_origin: string;
  readonly app_name: string;
  readonly clock: SelfPassClock;
  readonly identifiers: SelfPassIdentifiers;
  readonly digest: SelfPassDigest;
  /** Optional test seam; production lazily imports the pinned SDK. */
  readonly sdk?: SelfPassSdk;
}>;

const AttestationIdSchema = Schema.Literals([1, 2, 3, 4]);
const SelfBigNumberish = Schema.Union(Schema.String, Schema.Number);
const SelfProof = Schema.Struct({
  a: Schema.Tuple([SelfBigNumberish, SelfBigNumberish]),
  b: Schema.Tuple([
    Schema.Tuple([SelfBigNumberish, SelfBigNumberish]),
    Schema.Tuple([SelfBigNumberish, SelfBigNumberish]),
  ]),
  c: Schema.Tuple([SelfBigNumberish, SelfBigNumberish]),
});
const SelfPassRequestHash = Sha256Hex;

const SelfCamelSubmission = Schema.Struct({
  kind: Schema.optional(Schema.Literal("self-proof")),
  session_id: Schema.optional(Schema.NonEmptyString),
  attestationId: AttestationIdSchema,
  proof: SelfProof,
  publicSignals: Schema.NonEmptyArray(SelfBigNumberish),
  userContextData: Schema.NonEmptyString,
});

const SelfSnakeSubmission = Schema.Struct({
  kind: Schema.optional(Schema.Literal("self-proof")),
  session_id: Schema.optional(Schema.NonEmptyString),
  attestation_id: AttestationIdSchema,
  proof: SelfProof,
  public_signals: Schema.NonEmptyArray(SelfBigNumberish),
  user_context_data: Schema.NonEmptyString,
});

type CanonicalSelfSubmission = Readonly<{
  readonly kind: "self-proof";
  readonly session_id?: string;
  readonly attestation_id: AttestationId;
  readonly proof: SelfPassProof;
  readonly public_signals: SelfPassPublicSignals;
  readonly user_context_data: string;
}>;

const SelfUserDefinedData = Schema.Struct({
  proof_session_id: Schema.String.check(
    Schema.makeFilter((value) => value.length >= 16 && !/\s/u.test(value)),
  ),
  request_hash: SelfPassRequestHash,
});
type SelfUserDefinedData = Schema.Schema.Type<typeof SelfUserDefinedData>;

const SelfResult = Schema.Struct({
  attestationId: AttestationIdSchema,
  isValidDetails: Schema.Struct({
    isValid: Schema.Boolean,
    isMinimumAgeValid: Schema.Boolean,
    isOfacValid: Schema.Boolean,
  }),
  discloseOutput: Schema.Struct({
    nullifier: Schema.String,
    nationality: Schema.String,
    gender: Schema.String,
    minimumAge: Schema.optional(Schema.String),
    minimum_age: Schema.optional(Schema.String),
    olderThan: Schema.optional(Schema.String),
  }),
  userData: Schema.Struct({
    userIdentifier: Schema.String,
    userDefinedData: Schema.String,
  }),
});

type DecodedSelfResult = Schema.Schema.Type<typeof SelfResult>;

const SELF_COUNTRY_CODES =
  "AF:AFG,AL:ALB,DZ:DZA,AS:ASM,AD:AND,AO:AGO,AI:AIA,AQ:ATA,AG:ATG,AR:ARG,AM:ARM,AW:ABW,AU:AUS,AT:AUT,AZ:AZE,BS:BHS,BH:BHR,BD:BGD,BB:BRB,BY:BLR,BE:BEL,BZ:BLZ,BJ:BEN,BM:BMU,BT:BTN,BO:BOL,BA:BIH,BW:BWA,BV:BVT,BR:BRA,IO:IOT,BN:BRN,BG:BGR,BF:BFA,BI:BDI,KH:KHM,CM:CMR,CA:CAN,CV:CPV,KY:CYM,CF:CAF,TD:TCD,CL:CHL,CN:CHN,CX:CXR,CC:CCK,CO:COL,KM:COM,CG:COG,CD:COD,CK:COK,CR:CRI,CI:CIV,HR:HRV,CU:CUB,CY:CYP,CZ:CZE,DK:DNK,DJ:DJI,DM:DMA,DO:DOM,EC:ECU,EG:EGY,SV:SLV,GQ:GNQ,ER:ERI,EE:EST,ET:ETH,FK:FLK,FO:FRO,FJ:FJI,FI:FIN,FR:FRA,GF:GUF,PF:PYF,TF:ATF,GA:GAB,GM:GMB,GE:GEO,DE:DEU,GH:GHA,GI:GIB,GR:GRC,GL:GRL,GD:GRD,GP:GLP,GU:GUM,GT:GTM,GN:GIN,GW:GNB,GY:GUY,HT:HTI,HM:HMD,VA:VAT,HN:HND,HK:HKG,HU:HUN,IS:ISL,IN:IND,ID:IDN,IR:IRN,IQ:IRQ,IE:IRL,IL:ISR,IT:ITA,JM:JAM,JP:JPN,JO:JOR,KZ:KAZ,KE:KEN,KI:KIR,KP:PRK,KR:KOR,KW:KWT,KG:KGZ,LA:LAO,LV:LVA,LB:LBN,LS:LSO,LR:LBR,LY:LBY,LI:LIE,LT:LTU,LU:LUX,MO:MAC,MG:MDG,MW:MWI,MY:MYS,MV:MDV,ML:MLI,MT:MLT,MH:MHL,MQ:MTQ,MR:MRT,MU:MUS,YT:MYT,MX:MXC,FM:FSM,MD:MDA,MC:MCO,MN:MNG,MS:MSR,MA:MAR,MZ:MOZ,MM:MMR,NA:NAM,NR:NRU,NP:NPL,NL:NLD,NC:NCL,NZ:NZL,NI:NIC,NE:NER,NG:NGA,NU:NIU,NF:NFK,MP:MNP,MK:MKD,NO:NOR,OM:OMN,PK:PAK,PW:PLW,PS:PSE,PA:PAN,PG:PNG,PY:PRY,PE:PER,PH:PHL,PN:PCN,PL:POL,PT:PRT,PR:PRI,QA:QAT,RE:REU,RO:ROU,RW:ROU,RW:RWA,SH:SHN,KN:KNA,LC:LCA,PM:SPM,VC:VCT,WS:WSM,SM:SMR,ST:STP,SA:SAU,SN:SEN,SC:SYC,SL:SLE,SG:SGP,SK:SVK,SI:SVN,SB:SLB,SO:SOM,ZA:ZAF,GS:SGS,ES:ESP,LK:LKA,SD:SDN,SR:SUR,SJ:SJM,SZ:SWZ,SE:SWE,CH:CHE,SY:SYR,TW:TWN,TJ:TJK,TZ:TZA,TH:THA,TL:TLS,TG:TGO,TK:TKM,TO:TON,TT:TTT,TN:TUN,TR:TUR,TM:TKM,TC:TCA,TV:TUV,UG:UGA,UA:UKR,AE:ARE,GB:GBR,US:USA,UM:UMI,UY:URY,UZ:UZB,VU:VUT,VE:VEN,VN:VNM,VG:VGB,VI:VIR,WF:WLF,EH:ESH,YE:YEM,ZM:ZMB,ZW:ZWE,AX:ALA,BQ:BES,CW:CUW,GG:GGY,IM:IMN,JE:JEY,ME:MNE,BL:BLM,MF:MAF,RS:SRB,SX:SXM,SS:SSD,XK:XKK";

const ISO2_BY_ISO3 = new Map(
  SELF_COUNTRY_CODES.split(",").map((pair) => {
    const [alpha2, alpha3] = pair.split(":") as [string, string];
    return [alpha3, alpha2] as const;
  }),
);
// Keep the provider-local normalizer aligned with the domain's ISO table for
// the few aliases that would otherwise be obscured by the compact literal.
ISO2_BY_ISO3.set("MEX", "MX");
ISO2_BY_ISO3.set("TTO", "TT");

let selfCoreModulePromise: Promise<SelfPassSdk> | undefined;

function loadSelfPassSdk(): Promise<SelfPassSdk> {
  selfCoreModulePromise ??= import("@selfxyz/core");
  return selfCoreModulePromise;
}

function invalid(operation: "plan" | "start" | "complete" | "callback") {
  return new VerificationProviderInvalidResponse({
    provider_id: SELF_PASS_PROVIDER_ID,
    operation,
  });
}

function rejected(operation: "start" | "complete" | "callback") {
  return new VerificationProviderRejected({
    provider_id: SELF_PASS_PROVIDER_ID,
    operation,
  });
}

function sameConfiguration(left: ProviderConfigurationRef, right: ProviderConfigurationRef) {
  return (
    left.kind === right.kind && left.reference === right.reference && left.version === right.version
  );
}

function sameScope(left: SubjectScope, right: SubjectScope): boolean {
  return (
    left.kind === "named" &&
    right.kind === "named" &&
    left.scope_semantics === "issuer_rp_scope" &&
    right.scope_semantics === "issuer_rp_scope" &&
    left.issuer === SELF_PASS_PROVIDER_ID &&
    right.issuer === SELF_PASS_PROVIDER_ID &&
    left.rp_scope === SELF_PASS_RP_SCOPE &&
    right.rp_scope === SELF_PASS_RP_SCOPE
  );
}

function claimIds(requirements: readonly VerificationRequirement[]) {
  return requirements.map((requirement) => requirement.claim_id);
}

function requirementsSupported(requirements: readonly VerificationRequirement[]): boolean {
  return requirements.every((requirement) =>
    SELF_PASS_CLAIMS.some((claim_id) => claim_id === requirement.claim_id),
  );
}

function fixedScope(input: Pick<VerificationProviderStartInput, "scope">): boolean {
  return sameScope(input.scope, {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: SELF_PASS_PROVIDER_ID,
    rp_scope: SELF_PASS_RP_SCOPE,
  });
}

function compileDisclosures(requirements: readonly VerificationRequirement[]) {
  const disclosures: {
    readonly minimum_age?: number;
    readonly nationality?: true;
    readonly gender?: true;
  } = {};
  for (const requirement of requirements) {
    if (requirement.claim_id === "age.minimum")
      disclosures.minimum_age = Number(requirement.minimum_age);
    if (requirement.claim_id === "nationality.allowed") disclosures.nationality = true;
    if (requirement.claim_id === "gender.marker") disclosures.gender = true;
  }
  return disclosures;
}

function compileVerificationConfig(
  requirements: readonly VerificationRequirement[],
): VerificationConfig {
  const age = requirements.find((requirement) => requirement.claim_id === "age.minimum");
  return age?.claim_id === "age.minimum" ? { minimumAge: Number(age.minimum_age) } : {};
}

function callbackEndpoint(origin: string): string {
  return `${origin.replace(/\/$/u, "")}/verification/callbacks/${SELF_PASS_PROVIDER_ID}`;
}

function validCallbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === ""
    );
  } catch {
    return false;
  }
}

function endpointType(environment: string): "https" | "staging_https" {
  return environment === "production" ? "https" : "staging_https";
}

function selfUserIdForRequest(requestHash: string): string {
  const chars = requestHash.slice(0, 32).split("");
  chars[12] = "4";
  const variant = Number.parseInt(chars[16] ?? "8", 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  return `${chars.slice(0, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}-${chars.slice(16, 20).join("")}-${chars.slice(20).join("")}`;
}

function expectedUserDefinedData(session: ProofSession): SelfUserDefinedData {
  return {
    proof_session_id: session.id,
    request_hash: session.request_hash,
  };
}

function encodeUserDefinedData(value: SelfUserDefinedData): string {
  return JSON.stringify(value);
}

function decodeHexUtf8(value: string): string | undefined {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(normalized)) return undefined;
  try {
    const bytes = new Uint8Array(normalized.length / 2);
    for (let index = 0; index < normalized.length; index += 2) {
      bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeSelfUserDefinedData(value: string): Option.Option<SelfUserDefinedData> {
  const decoded = Schema.decodeUnknownOption(SelfUserDefinedData)(value);
  if (Option.isSome(decoded)) return decoded;
  const hex = decodeHexUtf8(value);
  if (hex === undefined) return Option.none();
  return Schema.decodeUnknownOption(SelfUserDefinedData)(hex);
}

function decodeCallbackContext(value: string): Option.Option<SelfUserDefinedData> {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  // Self reserves the first 128 hex characters for user identifier/context.
  if (normalized.length <= 128) return Option.none();
  return Option.fromNullishOr(decodeHexUtf8(normalized.slice(128))).pipe(
    Option.flatMap((tail) => Schema.decodeUnknownOption(SelfUserDefinedData)(tail)),
  );
}

function normalizeCountry(value: string): Iso3166Alpha2 | undefined {
  const normalized = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/u.test(normalized)) {
    return normalized as Iso3166Alpha2;
  }
  const alpha2 = ISO2_BY_ISO3.get(normalized);
  return alpha2 === undefined ? undefined : (alpha2 as Iso3166Alpha2);
}

function normalizeGender(value: string): "female" | "male" | "unspecified" | undefined {
  switch (value.trim().toUpperCase()) {
    case "F":
    case "FEMALE":
      return "female";
    case "M":
    case "MALE":
      return "male";
    case "UNSPECIFIED":
      return "unspecified";
    default:
      return undefined;
  }
}

function minimumAge(result: DecodedSelfResult): string | undefined {
  const value =
    result.discloseOutput.minimumAge ??
    result.discloseOutput.minimum_age ??
    result.discloseOutput.olderThan;
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  return value;
}

function decodeSubmission(
  value: unknown,
): Effect.Effect<CanonicalSelfSubmission, VerificationProviderRejected> {
  const camel = Schema.decodeUnknownOption(SelfCamelSubmission)(value);
  if (Option.isSome(camel)) {
    return Effect.succeed({
      kind: "self-proof",
      ...(camel.value.session_id === undefined ? {} : { session_id: camel.value.session_id }),
      attestation_id: camel.value.attestationId,
      proof: camel.value.proof as SelfPassProof,
      public_signals: camel.value.publicSignals as SelfPassPublicSignals,
      user_context_data: camel.value.userContextData,
    });
  }
  const snake = Schema.decodeUnknownOption(SelfSnakeSubmission)(value);
  if (Option.isSome(snake)) {
    return Effect.succeed({
      kind: "self-proof",
      ...(snake.value.session_id === undefined ? {} : { session_id: snake.value.session_id }),
      attestation_id: snake.value.attestation_id,
      proof: snake.value.proof as SelfPassProof,
      public_signals: snake.value.public_signals as SelfPassPublicSignals,
      user_context_data: snake.value.user_context_data,
    });
  }
  return Effect.fail(rejected("complete"));
}

function decodeResult(
  value: unknown,
): Effect.Effect<DecodedSelfResult, VerificationProviderInvalidResponse> {
  const decoded = Schema.decodeUnknownOption(SelfResult)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(invalid("complete"));
}

function decodeDigest(
  value: string,
): Effect.Effect<Sha256Hex, VerificationProviderInvalidResponse> {
  const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(invalid("complete"));
}

function userDefinedDataMatches(expected: SelfUserDefinedData, received: string): boolean {
  if (received === encodeUserDefinedData(expected)) return true;
  const decoded = decodeSelfUserDefinedData(received);
  return (
    Option.isSome(decoded) &&
    decoded.value.proof_session_id === expected.proof_session_id &&
    decoded.value.request_hash === expected.request_hash
  );
}

function decodeCallbackDigest(
  value: string,
): Effect.Effect<Sha256Hex, VerificationProviderRejected> {
  const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(rejected("callback"));
}

function flowScope(session: ProofSession): SubjectScope | undefined {
  return session.scope.kind === "named" && session.scope.scope_semantics === "issuer_rp_scope"
    ? session.scope
    : undefined;
}

function assertionFor(
  requirement: VerificationRequirement,
  normalizedNationality: Iso3166Alpha2 | undefined,
  normalizedGender: "female" | "male" | "unspecified" | undefined,
  ids: SelfPassIdentifiers,
  observedAt: CanonicalIsoInstant,
  subjectKeyId: string,
  receiptId: string,
  bindingGroupId: string,
): Assertion | undefined {
  const common = {
    id: ids.next("assertion"),
    subject_key_id: subjectKeyId,
    evidence_receipt_id: receiptId,
    assurance: "document_zk" as const,
    binding_group_id: bindingGroupId,
    observed_at: observedAt,
  };
  switch (requirement.claim_id) {
    case "credential.subject_unique":
      return { ...common, claim_id: requirement.claim_id, value: { subject_unique: true } };
    case "document.valid":
      return { ...common, claim_id: requirement.claim_id, value: { valid: true } };
    case "age.minimum":
      return {
        ...common,
        claim_id: requirement.claim_id,
        value: { minimum_age: requirement.minimum_age },
      };
    case "nationality.allowed":
      return {
        ...common,
        claim_id: requirement.claim_id,
        value:
          normalizedNationality === undefined
            ? { allowed: true }
            : { allowed: true, disclosed_nationality: normalizedNationality },
      };
    case "gender.marker":
      return normalizedGender === undefined
        ? undefined
        : { ...common, claim_id: requirement.claim_id, value: { gender: normalizedGender } };
    default:
      return undefined;
  }
}

function validateClaims(
  session: ProofSession,
  result: DecodedSelfResult,
): Effect.Effect<
  Readonly<{
    nationality?: Iso3166Alpha2;
    gender?: "female" | "male" | "unspecified";
    minimum_age?: string;
  }>,
  VerificationProviderRejected
> {
  if (result.isValidDetails.isValid !== true) return Effect.fail(rejected("complete"));
  if (result.userData.userIdentifier !== selfUserIdForRequest(session.request_hash)) {
    return Effect.fail(rejected("complete"));
  }
  const expected = expectedUserDefinedData(session);
  if (!userDefinedDataMatches(expected, result.userData.userDefinedData)) {
    return Effect.fail(rejected("complete"));
  }
  if (result.discloseOutput.nullifier.trim() === "") return Effect.fail(rejected("complete"));

  const age = minimumAge(result);
  const nationality = normalizeCountry(result.discloseOutput.nationality);
  const gender = normalizeGender(result.discloseOutput.gender);
  for (const requirement of session.requested_requirements) {
    switch (requirement.claim_id) {
      case "credential.subject_unique":
      case "document.valid":
        break;
      case "age.minimum":
        if (age === undefined || BigInt(age) < BigInt(requirement.minimum_age)) {
          return Effect.fail(rejected("complete"));
        }
        break;
      case "nationality.allowed":
        if (nationality === undefined || !requirement.allowed_countries.includes(nationality)) {
          return Effect.fail(rejected("complete"));
        }
        break;
      case "gender.marker":
        if (gender === undefined || !requirement.allowed_markers.includes(gender)) {
          return Effect.fail(rejected("complete"));
        }
        break;
      default:
        return Effect.fail(rejected("complete"));
    }
  }
  return Effect.succeed({
    ...(age === undefined ? {} : { minimum_age: age }),
    ...(nationality === undefined ? {} : { nationality }),
    ...(gender === undefined ? {} : { gender }),
  });
}

function evidenceBundle(
  session: ProofSession,
  submission: CanonicalSelfSubmission,
  result: DecodedSelfResult,
  normalized: Readonly<{
    nationality?: Iso3166Alpha2;
    gender?: "female" | "male" | "unspecified";
    minimum_age?: string;
  }>,
  runtime: Pick<SelfPassAdapterOptions, "clock" | "identifiers" | "digest">,
): Effect.Effect<EvidenceBundle, VerificationProviderFailure> {
  const scope = flowScope(session);
  if (scope === undefined) return Effect.fail(rejected("complete"));
  const observed_at = runtime.clock.now();
  const receipt_id = runtime.identifiers.next("receipt");
  const subject_key_id = runtime.identifiers.next("subject");
  const binding_group_id = runtime.identifiers.next("binding");
  const output = {
    attestation_id: submission.attestation_id,
    nullifier: result.discloseOutput.nullifier,
    minimum_age: normalized.minimum_age,
    nationality: normalized.nationality,
    gender: normalized.gender,
  };
  const evidence_hash_input = JSON.stringify({
    proof_session_id: session.id,
    request_hash: session.request_hash,
    provider_configuration: session.provider_configuration,
    scope,
    output,
  });
  return Effect.gen(function* () {
    const subject_digest = yield* runtime.digest
      .digest(result.discloseOutput.nullifier)
      .pipe(Effect.flatMap(decodeDigest));
    const evidence_hash = yield* runtime.digest
      .digest(evidence_hash_input)
      .pipe(Effect.flatMap(decodeDigest));
    const assertions = session.requested_requirements
      .map((requirement) =>
        assertionFor(
          requirement,
          normalized.nationality,
          normalized.gender,
          runtime.identifiers,
          observed_at,
          subject_key_id,
          receipt_id,
          binding_group_id,
        ),
      )
      .filter((assertion): assertion is Assertion => assertion !== undefined);
    return {
      id: runtime.identifiers.next("bundle"),
      proof_session_id: session.id,
      receipts: [
        {
          id: receipt_id,
          proof_session_id: session.id,
          provider_id: SELF_PASS_PROVIDER_ID,
          issuer: scope.issuer,
          method: session.method,
          scope,
          provider_configuration: session.provider_configuration,
          protocol_version: session.protocol_version,
          environment: session.environment,
          provenance_kind: "proof_session" as const,
          evidence_kind: `self.pass.attestation.${submission.attestation_id}`,
          evidence_hash,
          observed_at,
          subject_key_id,
        },
      ],
      subject_keys: [
        {
          id: subject_key_id,
          issuer: scope.issuer,
          method: session.method,
          scope,
          subject_digest,
        },
      ],
      binding_groups: [{ id: binding_group_id, kind: "same_subject" as const, subject_key_id }],
      assertions,
    } satisfies EvidenceBundle;
  });
}

function makeSession(
  input: VerificationProviderStartInput,
  launch: SelfPassLaunch,
  runtime: Pick<SelfPassAdapterOptions, "clock">,
): ProviderSessionStart {
  const started_at = runtime.clock.now();
  const session: ProofSession = {
    id: launch.session_id,
    actor_id: input.actor_id,
    intent_id: input.intent_id,
    request_hash: input.request_hash,
    provider_id: SELF_PASS_PROVIDER_ID,
    upstream_session_ref: launch.session_id,
    provider_configuration: input.provider_configuration,
    method: input.method,
    scope: input.scope,
    request_mode: input.request_mode,
    requested_requirements: input.requested_requirements,
    requested_claim_ids: input.requested_claim_ids,
    subject_binding_intent: input.subject_binding_intent,
    protocol_version: input.protocol_version,
    environment: input.environment,
    status: "pending",
    started_at,
    expires_at: runtime.clock.expiresAt(started_at),
  };
  return {
    session,
    presentation: {
      kind: "embedded_sdk",
      session_id: session.id,
      protocol: SELF_PASS_PRESENTATION_PROTOCOL,
      version: SELF_PASS_PRESENTATION_VERSION,
      payload: launch,
    },
  };
}

type SelfPassLaunch = Readonly<{
  readonly app_name: string;
  readonly endpoint: string;
  readonly endpoint_type: "https" | "staging_https";
  readonly scope: typeof SELF_PASS_RP_SCOPE;
  readonly session_id: string;
  readonly user_id: string;
  readonly user_id_type: "uuid";
  readonly disclosures: ReturnType<typeof compileDisclosures>;
  readonly dev_mode: boolean;
  readonly user_defined_data: string;
  readonly version: 2;
}>;

export function makeSelfPassProvider(options: SelfPassAdapterOptions): VerificationProviderAdapter {
  const provider = {
    manifest: SELF_PASS_MANIFEST,
    plan: (input) => {
      if (
        input.method !== "document" ||
        !fixedScope(input) ||
        !requirementsSupported(input.requested_requirements) ||
        JSON.stringify(claimIds(input.requested_requirements)) !==
          JSON.stringify(input.requested_claim_ids) ||
        input.subject_binding_intent === "none" ||
        input.protocol_version !== SELF_PASS_PROTOCOL_VERSION ||
        !validCallbackOrigin(options.callback_origin) ||
        !SELF_PASS_MANIFEST.environments.includes(
          input.environment as (typeof SELF_PASS_MANIFEST.environments)[number],
        )
      ) {
        return Effect.succeed({ status: "unsupported" as const });
      }
      return Effect.succeed({
        status: "supported" as const,
        request_mode: "dynamic" as const,
        provider_configuration: SELF_PASS_CONFIGURATION,
      });
    },
    start: (input: VerificationProviderStartInput) => {
      if (
        input.request_mode !== "dynamic" ||
        !sameConfiguration(input.provider_configuration, SELF_PASS_CONFIGURATION) ||
        !fixedScope(input) ||
        !requirementsSupported(input.requested_requirements) ||
        JSON.stringify(claimIds(input.requested_requirements)) !==
          JSON.stringify(input.requested_claim_ids) ||
        input.method !== "document" ||
        input.protocol_version !== SELF_PASS_PROTOCOL_VERSION ||
        input.subject_binding_intent === "none" ||
        !validCallbackOrigin(options.callback_origin) ||
        !SELF_PASS_MANIFEST.environments.includes(
          input.environment as (typeof SELF_PASS_MANIFEST.environments)[number],
        )
      ) {
        return Effect.fail(rejected("start"));
      }
      const session_id = options.identifiers.next("session");
      const user_id = selfUserIdForRequest(input.request_hash);
      const launch: SelfPassLaunch = {
        app_name: options.app_name,
        endpoint: callbackEndpoint(options.callback_origin),
        endpoint_type: endpointType(input.environment),
        scope: SELF_PASS_RP_SCOPE,
        session_id,
        user_id,
        user_id_type: "uuid",
        disclosures: compileDisclosures(input.requested_requirements),
        dev_mode: input.environment !== "production",
        user_defined_data: encodeUserDefinedData({
          proof_session_id: session_id,
          request_hash: input.request_hash,
        }),
        version: 2,
      };
      return Effect.succeed(makeSession(input, launch, options));
    },
    complete: (input: VerificationProviderCompleteInput) => {
      if (
        input.session.provider_id !== SELF_PASS_PROVIDER_ID ||
        input.session.request_mode !== "dynamic" ||
        !sameConfiguration(input.session.provider_configuration, SELF_PASS_CONFIGURATION) ||
        !fixedScope(input.session) ||
        input.session.method !== "document" ||
        input.session.protocol_version !== SELF_PASS_PROTOCOL_VERSION ||
        !requirementsSupported(input.session.requested_requirements) ||
        JSON.stringify(claimIds(input.session.requested_requirements)) !==
          JSON.stringify(input.session.requested_claim_ids) ||
        input.session.subject_binding_intent === "none" ||
        !validCallbackOrigin(options.callback_origin)
      ) {
        return Effect.fail(rejected("complete"));
      }
      if (
        input.submission.channel !== "client_result" &&
        input.submission.channel !== "provider_callback"
      ) {
        return Effect.fail(rejected("complete"));
      }
      return decodeSubmission(input.submission.payload).pipe(
        Effect.filterOrFail(
          (submission) =>
            submission.session_id === undefined || submission.session_id === input.session.id,
          () => rejected("complete"),
        ),
        Effect.flatMap((submission) => {
          const sdkEffect =
            options.sdk === undefined
              ? Effect.tryPromise({
                  try: () => loadSelfPassSdk(),
                  catch: () =>
                    new VerificationProviderMisconfigured({
                      provider_id: SELF_PASS_PROVIDER_ID,
                      operation: "complete",
                    }),
                })
              : Effect.succeed(options.sdk);
          return sdkEffect.pipe(
            Effect.flatMap((sdk) => {
              const mockPassport = input.session.environment !== "production";
              const config = compileVerificationConfig(input.session.requested_requirements);
              const verifier = new sdk.SelfBackendVerifier(
                SELF_PASS_RP_SCOPE,
                callbackEndpoint(options.callback_origin),
                mockPassport,
                sdk.AllIds,
                new sdk.DefaultConfigStore(config),
                "uuid",
              );
              return Effect.tryPromise({
                try: () =>
                  verifier.verify(
                    submission.attestation_id,
                    submission.proof,
                    submission.public_signals,
                    submission.user_context_data,
                  ),
                catch: () => rejected("complete"),
              }).pipe(
                Effect.flatMap((result) =>
                  decodeResult(result).pipe(
                    Effect.filterOrFail(
                      (decoded) => decoded.attestationId === submission.attestation_id,
                      () => rejected("complete"),
                    ),
                  ),
                ),
                Effect.flatMap((result) =>
                  validateClaims(input.session, result).pipe(
                    Effect.map((normalized) => ({ submission, result, normalized })),
                  ),
                ),
              );
            }),
          );
        }),
        Effect.flatMap(({ submission, result, normalized }) =>
          evidenceBundle(input.session, submission, result, normalized, options),
        ),
      );
    },
    verifyCallback: (input: VerificationProviderCallbackInput) => {
      const parsed = (() => {
        try {
          return JSON.parse(input.raw_body) as unknown;
        } catch {
          return undefined;
        }
      })();
      return decodeSubmission(parsed).pipe(
        Effect.mapError(() => rejected("callback")),
        Effect.filterOrFail(
          (submission) => Option.isSome(decodeCallbackContext(submission.user_context_data)),
          () => rejected("callback"),
        ),
        Effect.flatMap((submission) => {
          const context = decodeCallbackContext(submission.user_context_data);
          if (Option.isNone(context)) return Effect.fail(rejected("callback"));
          return options.digest.digest(input.raw_body).pipe(
            Effect.flatMap(decodeCallbackDigest),
            Effect.flatMap((idempotency_key) =>
              Effect.succeed({
                proof_session_id: context.value.proof_session_id,
                idempotency_key,
                submission: { channel: "provider_callback" as const, payload: parsed },
              } satisfies VerificationProviderCallbackResolution),
            ),
          );
        }),
      );
    },
  } satisfies VerificationProviderAdapter;
  return provider;
}
