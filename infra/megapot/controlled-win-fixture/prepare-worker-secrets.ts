/** Write isolated Wrangler secret files from injected Infisical variables. */
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const configDir = process.env.E2E_CONFIG_OUT_DIR;
const secretDir = process.env.E2E_SECRET_OUT_DIR;
if (!configDir?.startsWith("/tmp/") || !secretDir?.startsWith("/dev/shm/")) {
  throw new Error("absolute /tmp config and /dev/shm secret directories are required");
}

await mkdir(secretDir, { recursive: true, mode: 0o700 });

for (const kind of ["http", "jobs"] as const) {
  const config = JSON.parse(await readFile(resolve(configDir, `${kind}.json`), "utf8")) as {
    secrets: { required: string[] };
  };
  const contents: Record<string, string> = {};
  for (const name of config.secrets.required) {
    const source = name === "MEGAPOT_CUSTODY_PRIVATE_KEY"
      ? "MEGAPOT_E2E_CUSTODY_PRIVATE_KEY"
      : name === "MEGAPOT_GAS_TOPUP_PRIVATE_KEY"
        ? "MEGAPOT_E2E_GAS_TOPUP_PRIVATE_KEY"
        : name;
    const value = name === "MEGAPOT_COMMITMENT_PUBLIC_ORIGIN"
      ? "https://api-megapot-e2e-staging.pirate.sc"
      : process.env[source];
    if (!value) throw new Error(`missing ${source} for ${kind}`);
    // Infisical stores this PEM with a final newline. Session crypto requires
    // the key text without surrounding whitespace, as on the serving Worker.
    contents[name] = name === "PIRATE_APP_JWT_PRIVATE_KEY" ? value.trimEnd() : value;
  }
  const path = resolve(secretDir, `${kind}-secrets.json`);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(contents)}\n`);
  } finally {
    await file.close();
  }
  console.log(JSON.stringify({ kind, secretNames: Object.keys(contents), path }));
}
