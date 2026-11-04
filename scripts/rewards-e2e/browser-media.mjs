import { browserApi } from "./browser-api.mjs";
import { fixturePost } from "./run-evidence.mjs";

/** Check actual signed delivery and canonical audio bytes before any test funds move. */
export async function verifyBackingAudio(page) {
  const grant = await browserApi(page, `/api/posts/${fixturePost}/song/playback-access`, {
    method: "POST",
    body: {},
  });
  const result = await page.evaluate(
    async ({ url }) => {
      const resource = new URL(url);
      if (
        resource.hostname !== "08a4c22cf52e2ecae883e36f80a33f4a.r2.cloudflarestorage.com" ||
        resource.pathname !==
          "/pirate-media-immutable-megapot-e2e-staging/immutable/media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b/audio/1"
      )
        throw Error("Backing audio target is not isolated");
      let response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      } catch {
        throw Error("Real backing audio delivery refused before funding");
      }
      if (response.status !== 200) throw Error(`Backing audio HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== 2951824) throw Error("Backing audio size differs");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return {
        sha256: Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join(""),
        size: bytes.byteLength,
      };
    },
    { url: grant.playback_url },
  );
  if (result.sha256 !== "51afd9db7bb1e0be27c0d1fd4c55741d0570027dd6c20a6f087388e971c62d08")
    throw Error("Canonical backing audio digest differs");
  return result;
}
