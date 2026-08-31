import { applyPostgresTestBaseline } from "@pirate/testing/postgres";
import { Client } from "pg";

export async function applyPostgresTestBaselineConnection(options: {
  readonly connectionString: string;
}): Promise<void> {
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await applyPostgresTestBaseline(client);
  } finally {
    await client.end();
  }
}
