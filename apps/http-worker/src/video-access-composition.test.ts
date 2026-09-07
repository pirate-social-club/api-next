import { expect, test } from "bun:test";
import { makeDirectPostgresControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { makeVideoAccessHandlers } from "./video-access-composition.ts";

// Construction is lazy; these failure paths must never connect.
const unusedDb = makeDirectPostgresControlPlaneLayer("postgres://unused:unused@127.0.0.1:1/unused");

test("disabled delivery constructs no partially configured signer or storage access", async () => {
  const handlers = await makeVideoAccessHandlers({}, unusedDb);
  expect(() => handlers.GetVideoPoster({} as never)).toThrow("Video delivery unavailable");
  expect(() => handlers.CreateVideoPlaybackAccess({} as never)).toThrow(
    "Video delivery unavailable",
  );
});

test("enabled delivery refuses absent storage and secrets during composition", async () => {
  await expect(
    makeVideoAccessHandlers({ VIDEO_DELIVERY_ENABLED: "true" }, unusedDb),
  ).rejects.toThrow("MEDIA_DERIVED binding is required");
  await expect(
    makeVideoAccessHandlers(
      {
        VIDEO_DELIVERY_ENABLED: "true",
        MEDIA_DERIVED: { get: async () => null },
      },
      unusedDb,
    ),
  ).rejects.toThrow("VIDEO_STREAM_CUSTOMER_HOST binding is required");
});
