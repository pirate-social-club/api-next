import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { openKaraokePrivateDirectory } from "./karaoke-private-directory.ts";

/** Linux runner store. Directory FD anchors reads across pathname replacement. */
export function openKaraokePrivateArtifacts(directory: string) {
  const anchor = openKaraokePrivateDirectory(directory);
  let closed = false;
  return {
    read(name: string, maximumBytes: number): string {
      if (closed) throw new Error("karaoke_artifact_path_denied");
      return readKaraokePrivateArtifact(anchor, name, maximumBytes);
    },
    /** Content-addressed names only, for recovery discovery of retained
     * sidecars the journal does not reference. Never includes the manifest. */
    names(): string[] {
      if (closed) throw new Error("karaoke_artifact_path_denied");
      return readdirSync(`/proc/self/fd/${anchor.fd}`).filter((name) =>
        /^[a-f0-9]{64}\.json$/u.test(name),
      );
    },
    close() {
      if (!closed) {
        closed = true;
        anchor.close();
      }
    },
  };
}

export function readKaraokePrivateArtifact(
  anchor: ReturnType<typeof openKaraokePrivateDirectory>,
  name: string,
  maximumBytes: number,
): string {
  if (
    !/^(?:manifest\.signed|[a-f0-9]{64})\.json$/u.test(name) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 8_388_608
  ) {
    throw new Error("karaoke_artifact_path_denied");
  }
  const file = openSync(
    anchor.path(name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== anchor.uid ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maximumBytes
    ) {
      throw new Error("karaoke_artifact_file_denied");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(file, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fstatSync(file);
    if (
      count > maximumBytes ||
      count !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error("karaoke_artifact_file_changed");
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, count),
    );
  } finally {
    closeSync(file);
  }
}
