import { expect, test } from "bun:test";
import { songPostStatusProjectionFromRow } from "./song-post-projection";

test("public song statuses expose only their closed projection", () => {
  for (const alignment of ["not_applicable", "pending", "ready", "unavailable"] as const) {
    for (const registration of ["pending", "registered", "failed"] as const) {
      expect(
        songPostStatusProjectionFromRow({
          song_media_kind: "song",
          song_alignment: alignment,
          song_data_registration: registration,
          submission_id: "private-submission",
          evidence: "private-evidence",
        }),
      ).toEqual({ alignment, data_registration: registration });
    }
  }
});

test.each([
  {},
  { song_media_kind: "video", song_alignment: "ready", song_data_registration: "pending" },
  { song_media_kind: "song", song_alignment: "unknown", song_data_registration: "pending" },
  {
    song_media_kind: "song",
    song_alignment: "ready",
    song_data_registration: "registration_pending",
  },
])("missing or invalid song status stays unavailable", (row) => {
  expect(songPostStatusProjectionFromRow(row)).toBeNull();
});
