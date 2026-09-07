import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "karaoke-private-writer-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
};

test("artifact replay stays on the anchored inode after directory replacement", () => {
  const root = fixture();
  const directory = join(root, "run");
  mkdirSync(directory, { mode: 0o700 });
  const writer = openKaraokePrivateWriter(directory);
  try {
    const id = writer.putArtifact('{"a":1}');
    renameSync(directory, join(root, "retained"));
    mkdirSync(directory, { mode: 0o700 });
    expect(writer.putArtifact('{"a":1}')).toBe(id);
    writer.replaceManifest('{"payload":"fixture"}');
    expect(existsSync(join(directory, "manifest.signed.json"))).toBe(false);
    expect(readFileSync(join(root, "retained", "manifest.signed.json"), "utf8")).toBe(
      '{"payload":"fixture"}',
    );
    expect(statSync(join(root, "retained", `${id}.json`)).mode & 0o777).toBe(0o600);
  } finally {
    writer.close();
  }
});

test("immutable replay refuses symlinks, hardlinks and changed bytes", () => {
  for (const kind of ["symlink", "hardlink", "changed"] as const) {
    const root = fixture();
    const bytes = '{"a":1}';
    const id = createHash("sha256").update(bytes).digest("hex");
    const target = join(root, "target");
    writeFileSync(target, bytes, { mode: 0o600 });
    const name = join(root, `${id}.json`);
    if (kind === "symlink") symlinkSync(target, name);
    else if (kind === "hardlink") linkSync(target, name);
    else writeFileSync(name, "{}", { mode: 0o600 });
    const writer = openKaraokePrivateWriter(root);
    try {
      expect(() => writer.putArtifact(bytes)).toThrow();
    } finally {
      writer.close();
    }
  }
});

test("exclusive journal locking refuses a second writer and does not clear an abandoned lock", () => {
  const root = fixture();
  const first = openKaraokePrivateWriter(root);
  const second = openKaraokePrivateWriter(root);
  const release = first.lock();
  try {
    expect(() => second.lock()).toThrow();
    expect(existsSync(join(root, "journal.lock"))).toBe(true);
  } finally {
    release();
    first.close();
    second.close();
  }
  writeFileSync(join(root, "journal.lock"), "retained-crash-evidence", { mode: 0o600 });
  const later = openKaraokePrivateWriter(root);
  try {
    expect(() => later.lock()).toThrow();
    expect(readFileSync(join(root, "journal.lock"), "utf8")).toBe("retained-crash-evidence");
  } finally {
    later.close();
  }
});

test("permission changes after opening fail closed", () => {
  const root = fixture();
  const writer = openKaraokePrivateWriter(root);
  chmodSync(root, 0o755);
  try {
    expect(() => writer.putArtifact("{}")).toThrow("directory_denied");
  } finally {
    writer.close();
    chmodSync(root, 0o700);
  }
});
