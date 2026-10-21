/** The browser adapter's supported use-case entry point. Keep the single
 * contribution command/read implementation and its private replay, nonce,
 * authority and uncertainty semantics; this does not add another interpreter. */
export {
  type FundingScope,
  makeSongMegapotContributionReads,
  makeSongMegapotContributions,
  SongContributionFailure,
  type SongContributionPorts,
  type SongContributionReadPorts,
} from "../../rewards/song-megapot-contributions.ts";
