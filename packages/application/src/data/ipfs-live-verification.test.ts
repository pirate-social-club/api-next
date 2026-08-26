import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { type IpfsGatewayVerifier, pinAndVerifyIpfsArtifact } from "./ipfs-live-verification";
import type { IpfsPinningInput, IpfsPinningService } from "./ipfs-pinning";

const SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const CID = "bafkreie7mstupynzp4jr7k5wwrdss3e3n4badz47wpctk3tmo7ujw2uani";
const input: IpfsPinningInput = {
  version: "ipfs-pinning-v1",
  request_id: "artifact-1",
  filename: "song.mp3",
  content_type: "audio/mpeg",
  source: { byte_length: 4, open: async function* () {} },
  expected_byte_length: 4,
  expected_sha256: SHA256,
};
const pinning: IpfsPinningService = {
  pin: () =>
    Effect.succeed({
      status: "pinned",
      outcome: "pinned",
      cid: CID,
      byte_length: 4,
      sha256: SHA256,
      recursive: true,
    }),
};

describe("live IPFS verification composition", () => {
  test("converges only when the independent evidence matches the retained pin", async () => {
    const gateway: IpfsGatewayVerifier = {
      verify: () =>
        Effect.succeed({
          status: "verified",
          cid: CID,
          byte_length: 4,
          sha256: SHA256,
          provider_id: "ipfs.io",
        }),
    };
    expect(await Effect.runPromise(pinAndVerifyIpfsArtifact(pinning, gateway, input))).toEqual({
      status: "verified",
      pin: {
        status: "pinned",
        outcome: "pinned",
        cid: CID,
        byte_length: 4,
        sha256: SHA256,
        recursive: true,
      },
    });
  });

  test("rejects a gateway result for a different CID", async () => {
    const gateway: IpfsGatewayVerifier = {
      verify: () =>
        Effect.succeed({
          status: "verified",
          cid: `${CID}x`,
          byte_length: 4,
          sha256: SHA256,
          provider_id: "ipfs.io",
        }),
    };
    expect(await Effect.runPromise(pinAndVerifyIpfsArtifact(pinning, gateway, input))).toEqual({
      status: "gateway_failed",
      gateway: { status: "rejected", reason: "cid" },
    });
  });
});
