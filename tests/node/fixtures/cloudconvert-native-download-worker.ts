import { downloadSongVideoCloudConvertMaster } from "../../../packages/platform-cf/src/song-video-cloudconvert-download.ts";

export default {
  async fetch() {
    try {
      const result = await downloadSongVideoCloudConvertMaster({
        exportUrl: "https://us-east.storage.cloudconvert.com/native-fetch-fixture/master.mp4",
        fetch,
      });
      return Response.json({ byteLength: result.bytes.byteLength, sha256: result.sha256 });
    } catch (error) {
      return Response.json(
        { diagnostic: error instanceof Error ? error.message : "unknown" },
        { status: 500 },
      );
    }
  },
};
