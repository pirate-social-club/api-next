import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { openKaraokePrivateDirectory } from "./karaoke-private-directory.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";

export type ReleaseClaimCheckpoint = "created" | "written" | "file-synced" | "directory-synced";

/** Create-once exclusion, anchored to the private directory inode. No caller
 * may mutate until this returns true. Failure retains the partial claim;
 * neither this function nor recovery removes or overwrites it. */
export function persistKaraokeReleaseClaim(
  directory: string,
  bytes: string,
  checkpoint?: (stage: ReleaseClaimCheckpoint) => void,
): boolean {
  if (Buffer.byteLength(bytes, "utf8") > 262_144) throw new Error("karaoke_release_claim_size");
  const anchor = openKaraokePrivateDirectory(directory);
  try {
    let fd: number;
    try {
      fd = openSync(
        anchor.path("release-claim.json"),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      throw error;
    }
    try {
      checkpoint?.("created");
      writeFileSync(fd, bytes, "utf8");
      checkpoint?.("written");
      fsyncSync(fd);
      checkpoint?.("file-synced");
      fsyncSync(anchor.fd);
      checkpoint?.("directory-synced");
    } finally {
      closeSync(fd);
    }
    return true;
  } finally {
    anchor.close();
  }
}

/** Called only after authentication of the old cancellation and the new
 * intent's signed not-executed predecessor. Archive before replacing the
 * head; a crash leaves either the old cancellation or a refusing new claim.
 * The journal lock serializes successor selection across processes. */
export function replaceCancelledKaraokeReleaseClaim(
  directory: string,
  expectedBytes: string,
  bytes: string,
  checkpoint?: (stage: "archived" | "replacement-synced" | "renamed" | "directory-synced") => void,
): boolean {
  if (
    Buffer.byteLength(bytes, "utf8") > 262_144 ||
    Buffer.byteLength(expectedBytes, "utf8") > 262_144
  )
    throw new Error("karaoke_release_claim_size");
  const writer = openKaraokePrivateWriter(directory);
  let anchor: ReturnType<typeof openKaraokePrivateDirectory> | undefined;
  let unlock: (() => void) | undefined;
  try {
    anchor = openKaraokePrivateDirectory(directory);
    unlock = writer.lock();
    const fd = openSync(
      anchor.path("release-claim.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== anchor.uid ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 262_144
      )
        throw new Error("karaoke_release_claim_file_denied");
      if (readFileSync(fd, "utf8") !== expectedBytes) return false;
    } finally {
      closeSync(fd);
    }
    writer.putArtifact(expectedBytes);
    writer.putArtifact(bytes);
    checkpoint?.("archived");
    const temporary = `release-claim.${randomBytes(16).toString("hex")}.tmp`;
    const next = openSync(
      anchor.path(temporary),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(next, bytes, "utf8");
      fsyncSync(next);
    } finally {
      closeSync(next);
    }
    checkpoint?.("replacement-synced");
    renameSync(anchor.path(temporary), anchor.path("release-claim.json"));
    checkpoint?.("renamed");
    fsyncSync(anchor.fd);
    checkpoint?.("directory-synced");
    return true;
  } finally {
    try {
      unlock?.();
    } finally {
      anchor?.close();
      writer.close();
    }
  }
}
