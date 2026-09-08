import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readKaraokePrivateArtifact } from "./karaoke-private-artifacts.ts";
import { openKaraokePrivateDirectory } from "./karaoke-private-directory.ts";

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;

/** Separate from the operator's read-only store. All output is private and fsynced. */
export function openKaraokePrivateWriter(directory: string) {
  const anchor = openKaraokePrivateDirectory(directory);
  let closed = false;
  const writeNew = (name: string, bytes: string) => {
    if (closed) throw new Error("karaoke_writer_closed");
    const fd = openSync(
      anchor.path(name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  return {
    isNewJournal() {
      anchor.path("journal.lock");
      return readdirSync(`/proc/self/fd/${anchor.fd}`).every((name) => name === "journal.lock");
    },
    putArtifact(bytes: string) {
      if (Buffer.byteLength(bytes, "utf8") > 262_144) throw new Error("karaoke_artifact_size");
      const id = createHash("sha256").update(bytes, "utf8").digest("hex");
      const name = `${id}.json`;
      try {
        writeNew(name, bytes);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (readKaraokePrivateArtifact(anchor, name, 262_144) !== bytes)
          throw new Error("karaoke_artifact_replay_denied");
      }
      fsyncSync(anchor.fd);
      return id;
    },
    /** The signed manifest is the only replaceable file; immutable artifacts land first. */
    replaceManifest(bytes: string) {
      if (Buffer.byteLength(bytes, "utf8") > 8_388_608) throw new Error("karaoke_manifest_size");
      const temporary = `manifest.${randomBytes(16).toString("hex")}.tmp`;
      writeNew(temporary, bytes);
      try {
        renameSync(anchor.path(temporary), anchor.path("manifest.signed.json"));
        fsyncSync(anchor.fd);
      } catch (error) {
        try {
          unlinkSync(anchor.path(temporary));
        } catch (cleanup) {
          if (errorCode(cleanup) !== "ENOENT") throw new Error("karaoke_manifest_cleanup_failed");
        }
        throw error;
      }
    },
    /** An interrupted writer leaves the lock for explicit recovery, never automatic takeover. */
    lock() {
      const name = "journal.lock";
      writeNew(name, randomBytes(32).toString("hex"));
      const fd = openSync(anchor.path(name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const held = fstatSync(fd);
      let released = false;
      return () => {
        if (released) return;
        try {
          const current = openSync(anchor.path(name), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = fstatSync(current);
            if (stat.ino !== held.ino || stat.dev !== held.dev)
              throw new Error("karaoke_journal_lock_changed");
          } finally {
            closeSync(current);
          }
          unlinkSync(anchor.path(name));
          fsyncSync(anchor.fd);
        } finally {
          released = true;
          closeSync(fd);
        }
      };
    },
    close() {
      if (!closed) {
        closed = true;
        anchor.close();
      }
    },
  };
}
