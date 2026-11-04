/** Immutable settlement authority; reading it does not authorize a send. */
export type RewardObligationAuthority = Readonly<{
  attestationId: string;
  tokenAddress: string;
}>;
