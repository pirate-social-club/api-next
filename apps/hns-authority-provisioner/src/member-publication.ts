import { HNS_CANONICAL_AUTHORITY_ZONE_VERSION } from "@pirate/hns-dns-runtime/dns-axfr-zone";
import { Client } from "pg";
import {
  type HnsMemberRecordTarget,
  makePowerDnsMemberReader,
  makePowerDnsMemberWriter,
} from "./member-records.ts";
import {
  makePowerDnsRootInspector,
  type PowerDnsFetch,
  type PowerDnsRootProvisionConfig,
} from "./powerdns.ts";
import {
  makePowerDnsSecondaryAxfrAuthorizer,
  type PowerDnsSecondaryAxfrConfig,
} from "./secondary-axfr.ts";

type Context = Readonly<{
  grant_id: string;
  /** Set when the database deferred the job itself; no other field is then present. */
  deferred?: "root_busy" | "prepare_failed";
  sqlstate?: string;
  state: "preparing" | "ready" | "withdrawn";
  root_label: string;
  handle_label: string;
  authorized: boolean;
  dns_active: boolean;
  sale_generation: number | null;
  dns_generation: number | null;
  zone_bytes: string | null;
  zone_bytes_digest: string | null;
  challenge_txt_value: string | null;
  gateway_deployment_reference: string;
  gateway_certificate_spki_sha256: string;
}>;

type TurnResult = Readonly<{ claimed: boolean; outcome: string; detail?: unknown }>;

const A_TYPE = 1;
const TLSA_TYPE = 52;
const IN_CLASS = 1;
/** DANE-EE, SubjectPublicKeyInfo, SHA-256: the only profile the gateway publishes. */
const TLSA_PROFILE_HEX = "030101";

/**
 * Current accepted zone bytes, rather than an old job or process configuration,
 * own the target. The bytes are the canonical authority zone the readiness
 * observer stored: `{version, root_label, records}` with each record as
 * `[owner, type, class, ttl, rdata_hex]` and owners without a trailing dot.
 */
export function memberTargetFromZone(
  context: Pick<Context, "root_label" | "handle_label" | "grant_id" | "authorized" | "zone_bytes">,
): HnsMemberRecordTarget {
  if (context.zone_bytes === null) throw new Error("HNS member zone is unavailable");
  const parsed: unknown = JSON.parse(context.zone_bytes);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Reflect.get(parsed, "version") !== HNS_CANONICAL_AUTHORITY_ZONE_VERSION ||
    Reflect.get(parsed, "root_label") !== context.root_label
  )
    throw new Error("HNS member zone is invalid");
  const records: unknown = Reflect.get(parsed, "records");
  if (!Array.isArray(records)) throw new Error("HNS member zone is invalid");
  const value = (owner: string, type: number) => {
    const matches = records.filter(
      (row) => Array.isArray(row) && row[0] === owner && row[1] === type,
    );
    const row: unknown = matches[0];
    if (matches.length !== 1 || !Array.isArray(row)) {
      throw new Error("HNS member zone rrset is invalid");
    }
    const [, , recordClass, ttl, rdata] = row;
    if (
      recordClass !== IN_CLASS ||
      !Number.isSafeInteger(ttl) ||
      typeof rdata !== "string" ||
      !/^(?:[0-9a-f]{2})+$/u.test(rdata)
    )
      throw new Error("HNS member zone rrset is invalid");
    return { rdata, ttl: ttl as number };
  };
  const address = value(context.root_label, A_TYPE);
  const tlsa = value(`_443._tcp.${context.root_label}`, TLSA_TYPE);
  if (address.ttl !== tlsa.ttl) throw new Error("HNS member zone ttl differs");
  if (address.rdata.length !== 8) throw new Error("HNS member zone address is invalid");
  if (tlsa.rdata.length !== 70 || !tlsa.rdata.startsWith(TLSA_PROFILE_HEX))
    throw new Error("HNS member zone TLSA profile is unsupported");
  return {
    root_label: context.root_label,
    handle_label: context.handle_label,
    grant_id: context.grant_id,
    publish: context.authorized,
    gateway_ipv4: [0, 2, 4, 6]
      .map((offset) => Number.parseInt(address.rdata.slice(offset, offset + 2), 16))
      .join("."),
    shared_tlsa_association: `3 1 1 ${tlsa.rdata.slice(TLSA_PROFILE_HEX.length)}`,
    ttl_seconds: address.ttl,
  };
}

/** Only the SQLSTATE is safe to report; a driver message can carry connection details. */
function sqlstateOf(error: unknown): string | null {
  const code: unknown =
    error !== null && typeof error === "object" ? Reflect.get(error, "code") : null;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : null;
}

/**
 * One bounded transaction owns a job and the root lock; disconnect or crash
 * releases both for retry. A failure outside the provider exchange is reported
 * as an error at most once a minute, so a missing migration or grant is visible
 * in the service log without flooding it.
 *
 * Publication is off unless the deployment enables it. Installing this binary
 * therefore changes no member record by itself; the queue simply waits.
 */
export function makeHnsMemberPublicationRunner(
  connectionString: string,
  primaryConfig: PowerDnsRootProvisionConfig,
  secondaryConfig: PowerDnsSecondaryAxfrConfig | null,
  options: Readonly<{ enabled: boolean; transport?: PowerDnsFetch }>,
) {
  const transport = options.transport ?? fetch;
  let lastErrorReportAt = Number.NEGATIVE_INFINITY;
  return async (): Promise<TurnResult> => {
    if (!options.enabled) return { claimed: false, outcome: "disabled" };
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    client.on("error", disconnected);
    client.on("end", disconnected);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await client.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='50s'");
      const claimed = await client.query<{ context: Context | null }>(
        "SELECT prepare_hns_member_host_publication_v1() AS context",
      );
      const context = claimed.rows[0]?.context;
      if (!context) {
        await client.query("COMMIT");
        return { claimed: false, outcome: "idle" };
      }
      if (context.deferred !== undefined) {
        await client.query("COMMIT");
        return {
          claimed: true,
          outcome: `deferred_${context.deferred}`,
          ...(context.sqlstate === undefined ? {} : { detail: { sqlstate: context.sqlstate } }),
        };
      }
      let outcome: "ready" | "withdrawn" | "retry" = "retry";
      let reason: "authority_unavailable" | "provider_unavailable" = "authority_unavailable";
      let configuration: string | null = null;
      try {
        if (!context.authorized && context.state === "withdrawn") {
          // Already withdrawn and still unauthorized: the provider has nothing to change.
          configuration = context.zone_bytes_digest;
          outcome = "withdrawn";
        } else {
          if (
            context.challenge_txt_value === null ||
            secondaryConfig === null ||
            (context.authorized && !context.dns_active)
          )
            throw new Error("HNS member authority is unavailable");
          const target = memberTargetFromZone(context);
          const config = {
            ...primaryConfig,
            ...target,
            gateway_deployment_reference: context.gateway_deployment_reference,
            gateway_certificate_spki_sha256: context.gateway_certificate_spki_sha256,
          };
          const input = { ...target, challenge_txt_value: context.challenge_txt_value };
          configuration = context.zone_bytes_digest;
          timer = setTimeout(() => abort.abort(), 40_000);
          const fetcher: PowerDnsFetch = (url, init) =>
            transport(url, {
              ...init,
              signal: init?.signal ? AbortSignal.any([abort.signal, init.signal]) : abort.signal,
            });
          reason = "provider_unavailable";
          // A withdrawal still verifies the zone reservation, but need not wait
          // for a root configuration that is no longer active to become healthy.
          if (context.authorized) await makePowerDnsRootInspector(config, fetcher)(input);
          const serial = await makePowerDnsMemberWriter(config, fetcher)(input);
          await makePowerDnsSecondaryAxfrAuthorizer(
            secondaryConfig,
            fetcher,
          )({ ...input, minimum_serial: serial });
          await makePowerDnsMemberReader(secondaryConfig, fetcher)(input, serial);
          abort.signal.throwIfAborted();
          outcome = context.authorized ? "ready" : "withdrawn";
        }
      } catch {
        // Provider responses and connection strings must never enter logs or public status.
        outcome = "retry";
      } finally {
        clearTimeout(timer);
      }
      const completed = await client.query<{ state: string }>(
        "SELECT complete_hns_member_host_publication_v1($1,$2,$3,$4,$5,$6) AS state",
        [
          context.grant_id,
          outcome,
          context.sale_generation,
          context.dns_generation,
          configuration,
          outcome === "retry" ? reason : null,
        ],
      );
      await client.query("COMMIT");
      return {
        claimed: true,
        outcome: completed.rows[0]?.state ?? "retry",
        ...(outcome === "retry" ? { detail: { reason } } : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const now = Date.now();
      if (now - lastErrorReportAt < 60_000) {
        return { claimed: false, outcome: "member_publication_unavailable" };
      }
      lastErrorReportAt = now;
      return {
        claimed: false,
        outcome: "error",
        detail: { stage: "member_publication", sqlstate: sqlstateOf(error) },
      };
    } finally {
      abort.abort();
      clearTimeout(timer);
      await client.end().catch(() => undefined);
    }
  };
}
