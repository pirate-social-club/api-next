import { consumeSongPcmAdmission } from "../../../packages/platform-cf/src/song-video-pcm-admission.ts";
import type { SongPcmAdmission } from "../../../packages/platform-cf/src/song-video-pcm-admission-repository.ts";

const id = `song-pcm-${"a".repeat(64)}`;

export default {
  async fetch(_request: Request, env: { PCM: R2Bucket }) {
    let row: SongPcmAdmission = {
      admission_id: id,
      song_post_id: "song",
      song_community_id: "crew",
      audio_revision: "1",
      canonical_audio_sha256: "b".repeat(64),
      audio_asset_ref: "media://immutable/source.mp3",
      state: "processing",
      provider_job_id: "job-pcm",
      provider_create_started_at: new Date(),
      provider_wait_deadline: new Date(Date.now() + 60_000),
      cleanup_completed_at: null,
      failure_code: null,
      claim_owner: "worker",
      claim_fence: "1",
    };
    let facts: unknown = null;
    let cleaned = false;
    const repository = {
      claim: async () => row,
      get: async () => row,
      release: async () => {},
      admit: async (_claim: SongPcmAdmission, measured: unknown) => {
        facts = measured;
        row = { ...row, state: "admitted" };
      },
      revoke: async () => {},
      cleaned: async () => {
        cleaned = true;
      },
    } as unknown as Parameters<typeof consumeSongPcmAdmission>[1]["repository"];
    const outcome = await consumeSongPcmAdmission(
      { admission_id: id },
      {
        repository,
        bucket: env.PCM,
        apiKey: "test-only",
        sourceGatewayOrigin: "https://source.invalid",
        // Keep the actual native binding; a lambda misses incorrect receivers.
        fetch,
      },
    );
    return Response.json({ outcome, state: row.state, cleaned, facts });
  },
};
