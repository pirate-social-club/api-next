import { mkdir, writeFile } from "node:fs/promises";
import { generateClient, generateOpenApi, registry } from "@pirate/contracts";
import { serializeApiClientProvenance } from "./api-client-provenance.ts";

const root = new URL("../", import.meta.url);
const serverGenerated = new URL("apps/http-worker/src/generated/", root);
const clientGenerated = new URL("packages/api-client/src/generated/", root);
await Promise.all([
  mkdir(serverGenerated, { recursive: true }),
  mkdir(clientGenerated, { recursive: true }),
]);
const openapiText = `${JSON.stringify(generateOpenApi(registry), null, 2)}\n`;
const clientText = generateClient(registry);
await Promise.all([
  writeFile(new URL("openapi.json", serverGenerated), openapiText),
  writeFile(new URL("client.ts", clientGenerated), clientText),
  writeFile(
    new URL("provenance.json", clientGenerated),
    serializeApiClientProvenance(openapiText, clientText),
  ),
]);
await writeFile(
  new URL("route-table.ts", serverGenerated),
  `// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import { generateRouteTable, registry } from "@pirate/contracts";

export const routeTable = generateRouteTable(registry);
export { registry };
`,
);
