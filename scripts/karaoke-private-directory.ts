import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Anchor all later file operations to one verified Linux directory inode. */
export function openKaraokePrivateDirectory(directory: string) {
  if (
    process.platform !== "linux" ||
    !isAbsolute(directory) ||
    realpathSync(directory) !== resolve(directory)
  )
    throw new Error("karaoke_artifact_directory_denied");
  const before = lstatSync(directory);
  if (!before.isDirectory() || (before.mode & 0o077) !== 0 || before.uid !== process.getuid?.())
    throw new Error("karaoke_artifact_directory_denied");
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  if (
    opened.ino !== before.ino ||
    opened.dev !== before.dev ||
    opened.uid !== before.uid ||
    (opened.mode & 0o077) !== 0
  ) {
    closeSync(fd);
    throw new Error("karaoke_artifact_directory_changed");
  }
  let closed = false;
  return {
    fd,
    uid: before.uid,
    path(name: string) {
      if (closed || !/^[a-z0-9.-]{1,160}$/u.test(name) || name === "." || name === "..")
        throw new Error("karaoke_artifact_path_denied");
      const current = fstatSync(fd);
      if (current.uid !== before.uid || (current.mode & 0o077) !== 0)
        throw new Error("karaoke_artifact_directory_denied");
      return `/proc/self/fd/${fd}/${name}`;
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}
