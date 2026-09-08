import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function readKaraokePrivateFile(path: string, maximum: number): string {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path))
    throw new Error("operator_file_path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.size > maximum
    ) {
      throw new Error("operator_file_permissions");
    }
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      if (size === 0) break;
      count += size;
    }
    const after = fstatSync(fd);
    if (
      count !== before.size ||
      count > maximum ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("operator_file_changed");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, count),
    );
  } finally {
    closeSync(fd);
  }
}

export function outsideKaraokeEvidence(directory: string, path: string): boolean {
  const suffix = relative(resolve(directory), resolve(path));
  return suffix.startsWith("../") || suffix === ".." || isAbsolute(suffix);
}
