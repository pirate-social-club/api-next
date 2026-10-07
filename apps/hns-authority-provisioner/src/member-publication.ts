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
  root_label: string;
  handle_label: string;
  authorized: boolean;
  dns_active: boolean;
  sale_generation: number;
  dns_generation: number;
  zone_bytes: string | null;
  zone_bytes_digest: string | null;
  challenge_txt_value: string | null;
  gateway_deployment_reference: string;
  gateway_certificate_spki_sha256: string;
}>;

/** Current accepted zone bytes, rather than an old job or process configuration, own the target. */
function memberTargetFromZone(
  context: Pick<Context, "root_label" | "handle_label" | "grant_id" | "authorized" | "zone_bytes">,
): HnsMemberRecordTarget {
  if (context.zone_bytes === null) throw new Error("HNS member zone is unavailable");
  const parsed: unknown = JSON.parse(context.zone_bytes);
  if (!Array.isArray(parsed)) throw new Error("HNS member zone is invalid");
  const value = (name: string, type: string) => {
    const matches = parsed.filter((row) => row?.name === name && row?.type === type);
    const row = matches[0];
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(row.ttl) ||
      !Array.isArray(row.records) ||
      row.records.length !== 1 ||
      typeof row.records[0]?.content !== "string" ||
      row.records[0]?.disabled !== false
    )
      throw new Error("HNS member zone rrset is invalid");
    return { content: row.records[0].content as string, ttl: row.ttl as number };
  };
  const address = value(`${context.root_label}.`, "A");
  const tlsa = value(`_443._tcp.${context.root_label}.`, "TLSA");
  if (address.ttl !== tlsa.ttl) throw new Error("HNS member zone ttl differs");
  return {
    root_label: context.root_label,
    handle_label: context.handle_label,
    grant_id: context.grant_id,
    publish: context.authorized,
    gateway_ipv4: address.content,
    shared_tlsa_association: tlsa.content,
    ttl_seconds: address.ttl,
  };
}

/** One bounded transaction owns a job and the root lock; disconnect/crash releases both for retry. */
export function makeHnsMemberPublicationRunner(
  connectionString: string,
  primaryConfig: PowerDnsRootProvisionConfig,
  secondaryConfig: PowerDnsSecondaryAxfrConfig | null,
) {
  return async (): Promise<{ claimed: boolean; outcome: string }> => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    client.on("error", disconnected);
    client.on("end", disconnected);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await client.connect();
    try {
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
      let outcome = "retry";
      let reason = "authority_unavailable";
      let configuration: string | null = null;
      try {
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
          fetch(url, {
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
      } catch {
        // Provider responses and connection strings must never enter logs or public status.
        outcome = "retry";
      } finally {
        clearTimeout(timer);
      }
      const completed = await client.query<{ state: string }>(
        `UPDATE hns_member_host_publications SET
           state=CASE WHEN $2='ready' AND hns_member_host_authorized_v1(grant_id) THEN 'ready'
                      WHEN $2='withdrawn' THEN 'withdrawn' ELSE 'preparing' END,
           attempts=CASE WHEN $2='retry' THEN LEAST(attempts+1,30) ELSE 0 END,
           due_at=clock_timestamp()+CASE WHEN $2='retry'
             THEN make_interval(secs=>LEAST(300,5*power(2,LEAST(attempts,6)))::double precision)
             ELSE interval '120 seconds' END,
           sale_generation=$3,dns_generation=$4,configuration_sha256=$5,
           checked_at=clock_timestamp(),valid_until=CASE WHEN $2='ready'
             THEN clock_timestamp()+interval '5 minutes' ELSE NULL END,
           safe_reason=CASE WHEN $2='retry' THEN $6 ELSE NULL END,updated_at=clock_timestamp()
         WHERE grant_id=$1 RETURNING state`,
        [
          context.grant_id,
          outcome,
          context.sale_generation,
          context.dns_generation,
          configuration,
          reason,
        ],
      );
      await client.query("COMMIT");
      return { claimed: true, outcome: completed.rows[0]?.state ?? "retry" };
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return { claimed: false, outcome: "member_publication_unavailable" };
    } finally {
      abort.abort();
      clearTimeout(timer);
      await client.end().catch(() => undefined);
    }
  };
}
