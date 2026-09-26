import type { HnsRootDelegationDsV1 } from "@pirate/application/namespace-ownership";
import {
  makePowerDnsRootReconciler,
  type PowerDnsFetch,
  type PowerDnsRootProvisionConfig,
} from "./powerdns.ts";
import type { HnsZoneMutationLease } from "./provision-root.ts";
import {
  makePowerDnsSecondaryAxfrAuthorizer,
  type PowerDnsSecondaryAxfrConfig,
} from "./secondary-axfr.ts";
import { withHnsRootZoneMutation } from "./zone-mutation.ts";

const HNS_RECONCILE_PROVIDER_BUDGET_MS = 40_000;

/** Reconciles both authorities inside one fenced observation lease. */
export function makeFencedHnsRootZoneReconciler(
  connectionString: string,
  primaryConfig: PowerDnsRootProvisionConfig,
  secondaryConfig: PowerDnsSecondaryAxfrConfig | null,
): (input: {
  readonly root_label: string;
  readonly challenge_txt_value: string;
  readonly expected_ds_records: readonly HnsRootDelegationDsV1[];
  readonly mutation_lease?: HnsZoneMutationLease;
}) => Promise<void> {
  return (input) =>
    withHnsRootZoneMutation(connectionString, input, false, async (signal) => {
      if (secondaryConfig === null)
        throw new Error("HNS secondary AXFR authorization is not configured");
      // Both provider steps share one 60-second observation lease. Leave time
      // for the fenced transaction and job finalization after their requests.
      const budget = new AbortController();
      const timer = setTimeout(
        () => budget.abort(new Error("HNS authority reconciliation timed out")),
        HNS_RECONCILE_PROVIDER_BUDGET_MS,
      );
      const mutationSignal = AbortSignal.any([signal, budget.signal]);
      const providerFetch: PowerDnsFetch = (url, init) =>
        fetch(url, {
          ...init,
          signal: init?.signal ? AbortSignal.any([mutationSignal, init.signal]) : mutationSignal,
        });
      try {
        await makePowerDnsRootReconciler(primaryConfig, providerFetch)(input);
        await makePowerDnsSecondaryAxfrAuthorizer(secondaryConfig, providerFetch)(input);
        mutationSignal.throwIfAborted();
      } finally {
        clearTimeout(timer);
      }
    });
}
