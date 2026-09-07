import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Linux runner store. Directory FD anchors reads across pathname replacement. */
export function openKaraokePrivateArtifacts(directory: string) {
  if (
    process.platform !== "linux" ||
    !isAbsolute(directory) ||
    realpathSync(directory) !== resolve(directory)
  ) {
    throw new Error("karaoke_artifact_directory_denied");
  }
  const before = lstatSync(directory);
  if (!before.isDirectory() || (before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()) {
    throw new Error("karaoke_artifact_directory_denied");
  }
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  if (opened.ino !== before.ino || opened.dev !== before.dev) {
    closeSync(fd);
    throw new Error("karaoke_artifact_directory_changed");
  }
  let closed = false;
  return {
    read(name: string, maximumBytes: number): string {
      if (
        closed ||
        !/^(?:manifest\.signed|[a-f0-9]{64})\.json$/u.test(name) ||
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes < 1 ||
        maximumBytes > 8_388_608
      ) {
        throw new Error("karaoke_artifact_path_denied");
      }
      const file = openSync(
        `/proc/self/fd/${fd}/${name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = fstatSync(file);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.uid !== before.uid ||
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
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}
