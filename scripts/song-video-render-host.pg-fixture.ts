import { expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";

/** Restricted fixture grants, including invoker timing ownership reads. */
export async function grantRenderHostFixturePrivileges(
  admin: Client,
  schema: string,
  hostRole: string,
): Promise<void> {
  await admin.query(
    `GRANT SELECT ON
         "${schema}".media_song_video_render_attempts,
         "${schema}".media_song_video_render_plans,
         "${schema}".media_post_submissions,
         "${schema}".media_video_reservation_song_plans,
         "${schema}".media_video_revisions,
         "${schema}".media_immutable_objects,
         "${schema}".media_song_video_masters,
         "${schema}".media_song_video_accepted_masters,
         "${schema}".media_publication_projections,
         "${schema}".media_song_canonical_timings,
         "${schema}".media_song_video_pcm_admissions
       TO "${hostRole}"`,
  );
  await admin.query(
    `GRANT UPDATE ON
         "${schema}".media_song_video_render_attempts,
         "${schema}".media_song_canonical_timings
       TO "${hostRole}"`,
  );
  await admin.query(`GRANT UPDATE (etag) ON "${schema}".media_immutable_objects TO "${hostRole}"`);
  await admin.query(
    `GRANT INSERT ON
         "${schema}".media_song_video_masters,
         "${schema}".media_song_video_accepted_masters
       TO "${hostRole}"`,
  );
}

export async function assertRenderHostFixturePrivileges(
  connectionString: string,
  hostRole: string,
  operationId: string,
): Promise<void> {
  const roleClient = new Client({ connectionString: connectionString });
  await roleClient.connect();
  try {
    const identity = await roleClient.query<{ current_user: string }>("SELECT current_user");
    expect(identity.rows[0]?.current_user).toBe(hostRole);
    // The invoker timing guard reads admission ownership; the retained host
    // must still have no authority to alter an automatic admission.
    const admissionPrivileges = await roleClient.query<{ privilege: string; allowed: boolean }>(
      `SELECT privilege, has_table_privilege(current_user,
           'media_song_video_pcm_admissions', privilege) AS allowed
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS privilege`,
    );
    expect(admissionPrivileges.rows).toEqual([
      { privilege: "SELECT", allowed: true },
      { privilege: "INSERT", allowed: false },
      { privilege: "UPDATE", allowed: false },
      { privilege: "DELETE", allowed: false },
      { privilege: "TRUNCATE", allowed: false },
    ]);
    const readObject = () =>
      roleClient.query<{ object: Record<string, unknown> }>(
        `SELECT to_jsonb(object) AS object FROM media_immutable_objects AS object
            WHERE immutable_ref = $1`,
        [`media://immutable/${operationId}/video/1`],
      );
    const before = await readObject();
    expect(before.rows).toHaveLength(1);
    // The column grant exists for the FOR SHARE lock the seal takes; the
    // append-only trigger must still refuse any actual mutation.
    await expect(
      roleClient.query(
        `UPDATE media_immutable_objects SET etag = etag || '-mutated'
            WHERE immutable_ref = $1`,
        [`media://immutable/${operationId}/video/1`],
      ),
    ).rejects.toThrow(/append-only/u);
    const after = await readObject();
    expect(after.rows).toEqual(before.rows);
  } finally {
    await roleClient.end();
  }
}

export async function ffmpegTool(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(`ffmpeg failed: ${stderr.slice(0, 200)}`);
}

export async function decodedSampleCount(directory: string, bytes: Uint8Array): Promise<number> {
  const input = join(directory, "measure.bin");
  const output = `${input}.pcm`;
  await writeFile(input, bytes);
  await ffmpegTool([
    "-y",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-af",
    "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    output,
  ]);
  return (await readFile(output)).byteLength / 4;
}
