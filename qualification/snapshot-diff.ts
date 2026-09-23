// Compares two table snapshots against one write manifest: the set of tables
// allowed to change. Prints every changed table and exits 1 if any changed
// table is outside the manifest.
const [beforePath, afterPath, ...allowed] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("usage: snapshot-diff.ts <before.json> <after.json> [table...]");
type Snap = { tables: Record<string, { rows: number; md5: string }> };
const before = (await Bun.file(beforePath).json()) as Snap;
const after = (await Bun.file(afterPath).json()) as Snap;
const names = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
const changed = [...names].sort().filter((name) => JSON.stringify(before.tables[name]) !== JSON.stringify(after.tables[name]));
const outside = changed.filter((name) => !allowed.includes(name));
console.log(JSON.stringify({
  changed: changed.map((name) => ({ table: name, before: before.tables[name] ?? null, after: after.tables[name] ?? null })),
  outside_manifest: outside,
}, null, 1));
if (outside.length > 0) process.exitCode = 1;
