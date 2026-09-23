/**
 * Read-only and credential helpers for the branch run. Every value that could
 * be a secret is written only to files under QUAL_PRIVATE_DIR (mode 0600);
 * stdout carries identifiers, digests, counts and booleans only.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { Client } from "pg";

const account = "08a4c22cf52e2ecae883e36f80a33f4a";
const bucket = "pirate-media-immutable-staging";
const out = (value: unknown) => console.log(JSON.stringify(value, null, 1));
const privateDir = () => {
  const dir = process.env.QUAL_PRIVATE_DIR;
  if (!dir) throw new Error("QUAL_PRIVATE_DIR is required");
  return dir;
};
const secretFile = async (name: string, contents: string) => {
  const path = `${privateDir()}/${name}`;
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
};

/** Turns a PlanetScale database_url into what node-pg and the host accept. */
export function pgUrl(raw: string, searchPath = true): string {
  const url = new URL(raw);
  if (url.searchParams.get("sslrootcert") === "system") url.searchParams.delete("sslrootcert");
  if (searchPath) url.searchParams.set("options", "-c search_path=api_next");
  return url.toString();
}

async function saveRole() {
  // stdin: `pscale role create --format json` output; argv: file name for the URL.
  const created = JSON.parse(await Bun.stdin.text()) as {
    id?: string;
    name?: string;
    username?: string;
    access_host_url?: string;
    database_url?: string;
    expires_at?: string;
  };
  if (!created.database_url || !created.id || !created.username) throw new Error("role shape unproven");
  const name = process.argv[3];
  if (!name) throw new Error("role file name is required");
  await secretFile(`${name}.url`, pgUrl(created.database_url));
  const base = created.username.split(".")[0];
  out({ role_id: created.id, name: created.name, username: created.username, base_username: base, branch_suffix: created.username.split(".")[1] ?? null, host: created.access_host_url, expires_at: created.expires_at ?? null });
}

async function sql() {
  // argv: <url-file> <sql>; prints rows as JSON. For identity and read-only checks.
  const url = (await readFile(`${privateDir()}/${process.argv[3]}`, "utf8")).trim();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    out((await client.query(process.argv[4] ?? "SELECT 1")).rows);
  } finally {
    await client.end();
  }
}

async function mint() {
  // argv: <name> <permission> <ttlSeconds> [--object key]... [--prefix p]...
  const [, , , name, permission, ttl, ...rest] = process.argv;
  const objects: string[] = [];
  const prefixes: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--object" && rest[i + 1]) objects.push(rest[i + 1] as string);
    else if (rest[i] === "--prefix" && rest[i + 1]) prefixes.push(rest[i + 1] as string);
    else throw new Error("mint scope must be --object or --prefix pairs");
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/temp-access-credentials`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.VIDEO_QUALIFICATION_R2_MINT_API_TOKEN?.trim()}`, "content-type": "application/json" },
    body: JSON.stringify({
      bucket,
      parentAccessKeyId: process.env.VIDEO_QUALIFICATION_R2_ACCESS_KEY_ID?.trim(),
      permission,
      ttlSeconds: Number(ttl),
      ...(objects.length ? { objects } : {}),
      ...(prefixes.length ? { prefixes } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; result?: { accessKeyId: string; secretAccessKey: string; sessionToken: string }; errors?: unknown };
  if (!body.success || !body.result) {
    out({ mint: name, http: response.status, success: false, errors: body.errors ?? null });
    process.exitCode = 1;
    return;
  }
  await secretFile(`${name}.json`, JSON.stringify(body.result));
  out({ mint: name, http: response.status, success: true, permission, ttl_seconds: Number(ttl), objects, prefixes });
}

async function hostEnv() {
  // argv: <out-name> <db-url-file> <input-cred> [<output-cred>] [KEY=VALUE]...
  const [, , , outName, dbFile, inputName, outputName, ...extra] = process.argv;
  const read = async (n: string) => JSON.parse(await readFile(`${privateDir()}/${n}.json`, "utf8")) as { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  const lines = [
    `SONG_VIDEO_RENDER_DATABASE_URL=${(await readFile(`${privateDir()}/${dbFile}`, "utf8")).trim()}`,
    `SONG_VIDEO_RENDER_R2_ACCOUNT_ID=${account}`,
    `SONG_VIDEO_RENDER_R2_BUCKET=${bucket}`,
  ];
  const input = await read(inputName as string);
  lines.push(
    `SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID=${input.accessKeyId}`,
    `SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY=${input.secretAccessKey}`,
    `SONG_VIDEO_RENDER_R2_INPUT_SESSION_TOKEN=${input.sessionToken}`,
  );
  if (outputName && outputName !== "-") {
    const output = await read(outputName);
    lines.push(
      `SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID=${output.accessKeyId}`,
      `SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY=${output.secretAccessKey}`,
      `SONG_VIDEO_RENDER_R2_SESSION_TOKEN=${output.sessionToken}`,
    );
  }
  for (const pair of extra) lines.push(pair);
  await secretFile(`${outName}.env`, `${lines.join("\n")}\n`);
  out({ host_env: outName, variables: lines.map((line) => line.split("=")[0]) });
}

async function uploadEnv() {
  // argv: <cred-name>: prints shell exports into a private file for the driver's upload.
  const c = JSON.parse(await readFile(`${privateDir()}/${process.argv[3]}.json`, "utf8")) as { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  await secretFile("upload.env", `QUAL_R2_ACCESS_KEY_ID=${c.accessKeyId}\nQUAL_R2_SECRET_ACCESS_KEY=${c.secretAccessKey}\nQUAL_R2_SESSION_TOKEN=${c.sessionToken}\n`);
  out({ upload_env: true });
}

const commands: Record<string, () => Promise<void>> = { "save-role": saveRole, sql, mint, "host-env": hostEnv, "upload-env": uploadEnv };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error(`usage: branch-helpers.ts <${Object.keys(commands).join("|")}>`);
  process.exitCode = 2;
} else {
  await command().catch((error: unknown) => {
    console.error((error instanceof Error ? error.message : "failed").replace(/postgres(ql)?:\/\/\S+/gu, "<url>").slice(0, 300));
    process.exitCode = 1;
  });
}
