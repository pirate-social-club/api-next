import { writeFileSync } from "node:fs";
import { decodeEventLog, parseAbi } from "viem";
import { fixtureAccounts } from "./browser-accounts.mjs";
import { fixtureJackpot } from "./fixture-chain.mjs";

export const fixtureCommunity = "community_d77ee63a-e0dc-4162-aab1-ae593b533bda";
export const fixturePost = "media-post-media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b";
export const fixturePersonas = {
  sponsor: "persona_ddf1635e87aa408982204138cf79697d",
  study: "persona_ddf1635e87aa408982204138cf79697d",
  karaoke: "persona_adc838ab24b64da98584a8960dcd55a4",
};
export const fixtureCustody = "0x544881290138fe0e66c1ec7d1a1f141395246f20";
export const fixtureSponsorWallet = "0x8b4fa94e81ea7ae27f9f290f4dee663e69355fe3";
export const fixtureAttestation = "megapot-e2e-sepolia-20261004-r2";
export const fixtureSourceTag =
  "0xd983aed13a9e80ef6897e1d20ef0d3d4dd386fee52ad534dfe8acad973a575e4";
const ticketEvent = parseAbi([
  "event TicketPurchased(address indexed recipient,uint256 indexed currentDrawingId,bytes32 indexed source,uint256 userTicketId,uint8[] normals,uint8 bonusball,bytes32 referralScheme)",
]);

export function saveRunEvidence(run, stage, evidence) {
  if (!/^[a-z][a-z0-9-]+$/.test(stage)) throw Error("Evidence stage differs");
  writeFileSync(
    `${run.directory}/${stage}.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        apiSource: run.apiSource,
        solidSource: run.solidSource,
        simulatedClaimVerification: true,
        ...evidence,
      },
      (_, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}

/** Retry reads only. Mutation callers use executeOnce and never enter this loop. */
export async function waitForEvidence(stage, deadline, read, accept, check = async () => {}) {
  while (Date.now() < deadline) {
    await check();
    if (Date.now() >= deadline) break;
    const result = await read();
    if (Date.now() >= deadline) break;
    if (accept(result)) return result;
    await Bun.sleep(2000);
  }
  throw Error(`${stage} evidence deadline expired`);
}

export function assertActivityShares(shares) {
  if (shares.length !== 2) throw Error("Exactly two independent activity shares required");
  for (const role of ["study", "karaoke"]) {
    const rows = shares.filter(
      (row) =>
        row.account_id === fixtureAccounts[role].accountId &&
        row.persona_id === fixturePersonas[role] &&
        row.activity_key === role &&
        Number(row.score_bps) >= 7000,
    );
    if (rows.length !== 1) throw Error(`${role} share is missing or ambiguous`);
  }
  return true;
}

export function expectedTicketLogs(receipt, expected) {
  const logs = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== fixtureJackpot) continue;
    let event;
    try {
      event = decodeEventLog({ abi: ticketEvent, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (event.eventName !== "TicketPurchased") continue;
    const args = event.args;
    if (
      args.recipient.toLowerCase() !== fixtureCustody ||
      args.source !== fixtureSourceTag ||
      args.currentDrawingId.toString() !== expected.drawingId ||
      args.userTicketId.toString() !== expected.ticketId
    )
      throw Error("Ticket receipt terms differ");
    logs.push(log);
  }
  if (logs.length !== 1) throw Error("Exactly one custody ticket purchase required");
  return logs.length;
}
