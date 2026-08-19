import { readFile } from "node:fs/promises";
import { generateClient, generateOpenApi, registry } from "@pirate/contracts";
import { serializeApiClientProvenance } from "./api-client-provenance.ts";

const serverGenerated = new URL("../apps/http-worker/src/generated/", import.meta.url);
const clientGenerated = new URL("../packages/api-client/src/generated/", import.meta.url);
const openapiText = `${JSON.stringify(generateOpenApi(registry), null, 2)}\n`;
const clientText = generateClient(registry);
const expected = [
  [new URL("openapi.json", serverGenerated), openapiText],
  [new URL("client.ts", clientGenerated), clientText],
  [
    new URL("provenance.json", clientGenerated),
    serializeApiClientProvenance(openapiText, clientText),
  ],
  [
    new URL("route-table.ts", serverGenerated),
    `// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import { generateRouteTable, registry } from "@pirate/contracts";

export const routeTable = generateRouteTable(registry);
export { registry };
`,
  ],
] as const;
const forbiddenGeneratedValues = [
  "COMMUNITY_PURCHASE_FUNDING_RPC_URL",
  process.env.COMMUNITY_PURCHASE_FUNDING_RPC_URL ?? "",
].filter((value) => value !== "");
let stale = false;
for (const [url, value] of expected) {
  for (const forbidden of forbiddenGeneratedValues) {
    if (value.includes(forbidden)) {
      console.error(`Generated contract contains money-path configuration: ${url.pathname}`);
      stale = true;
    }
  }
  const actual = await readFile(url, "utf8").catch(() => "");
  if (actual !== value) {
    console.error(`Generated contract is stale: ${url.pathname}. Run bun run generate:contracts`);
    stale = true;
  }
}
if (stale) process.exit(1);
