import { readFile } from "node:fs/promises";
import { generateClient, generateOpenApi, registry } from "@pirate/contracts";

const serverGenerated = new URL("../apps/http-worker/src/generated/", import.meta.url);
const clientGenerated = new URL("../packages/api-client/src/generated/", import.meta.url);
const expected = [
  [
    new URL("openapi.json", serverGenerated),
    `${JSON.stringify(generateOpenApi(registry), null, 2)}\n`,
  ],
  [new URL("client.ts", clientGenerated), generateClient(registry)],
  [
    new URL("route-table.ts", serverGenerated),
    `// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import { generateRouteTable, registry } from "@pirate/contracts";

export const routeTable = generateRouteTable(registry);
export { registry };
`,
  ],
] as const;
let stale = false;
for (const [url, value] of expected) {
  const actual = await readFile(url, "utf8").catch(() => "");
  if (actual !== value) {
    console.error(`Generated contract is stale: ${url.pathname}. Run bun run generate:contracts`);
    stale = true;
  }
}
if (stale) process.exit(1);
