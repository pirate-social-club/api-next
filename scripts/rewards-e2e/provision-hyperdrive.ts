import { createHash } from "node:crypto";
import {
  type IsolatedDatabaseIdentity,
  validateIsolatedDatabaseIdentity,
} from "./bootstrap-database.ts";
import { cloudflareApi } from "./cloudflare-api.mjs";

type Hyperdrive = {
  id: string;
  name: string;
  origin: { host: string; user: string; database: string };
  caching: { disabled: boolean };
};

/** Create once or adopt only a configuration matching independent provider pins. */
export async function provisionIsolatedHyperdrive(
  input: {
    readonly connectionString: string;
    readonly identity: IsolatedDatabaseIdentity;
  },
  api = cloudflareApi,
) {
  const connection = validateIsolatedDatabaseIdentity(input.connectionString, input.identity);
  const name = `rewards-runner-${input.identity.branchId}`;
  const matches = ((await api("/hyperdrive/configs")) as Hyperdrive[]).filter(
    (candidate) => candidate.name === name,
  );
  if (matches.length > 1) throw new Error("Isolated Hyperdrive identity is ambiguous");
  let id = matches[0]?.id;
  if (!id) {
    const created = (await api("/hyperdrive/configs", {
      method: "POST",
      body: JSON.stringify({
        name,
        origin: {
          scheme: "postgresql",
          host: connection.hostname,
          port: Number(connection.port || 5432),
          user: decodeURIComponent(connection.username),
          password: decodeURIComponent(connection.password),
          database: connection.pathname.slice(1),
        },
        caching: { disabled: true },
        origin_connection_limit: 5,
      }),
    })) as Hyperdrive;
    id = created.id;
  }
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid isolated Hyperdrive identifier");
  const observed = (await api(`/hyperdrive/configs/${id}`)) as Hyperdrive;
  if (
    observed.name !== name ||
    observed.origin.host !== input.identity.hostname ||
    createHash("sha256").update(observed.origin.user).digest("hex") !==
      input.identity.usernameSha256 ||
    observed.origin.database !== connection.pathname.slice(1) ||
    observed.caching.disabled !== true
  ) {
    throw new Error("Isolated Hyperdrive readback differs from the verified database role");
  }
  return { id, name, branchId: input.identity.branchId, cachingDisabled: true };
}
