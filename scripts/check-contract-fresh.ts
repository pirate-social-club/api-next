import { readFile } from "node:fs/promises";
import { generateClient, generateOpenApi, registry } from "@pirate/contracts";
import { serializeApiClientProvenance } from "./api-client-provenance.ts";

const root = new URL("../", import.meta.url);
const serverGenerated = new URL("apps/http-worker/src/generated/", root);
const clientGenerated = new URL("packages/api-client/src/generated/", root);
const clientPackage = JSON.parse(
  await readFile(new URL("packages/api-client/package.json", root), "utf8"),
) as { readonly version: string };
const openapiText = `${JSON.stringify(generateOpenApi(registry), null, 2)}\n`;
const clientText = generateClient(registry);
const expected = [
  [new URL("openapi.json", serverGenerated), openapiText],
  [new URL("client.ts", clientGenerated), clientText],
  [
    new URL("provenance.json", clientGenerated),
    serializeApiClientProvenance(openapiText, clientText, clientPackage.version),
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
let stale = false;
for (const [url, value] of expected) {
  const actual = await readFile(url, "utf8").catch(() => "");
  if (actual !== value) {
    console.error(`Generated contract is stale: ${url.pathname}. Run bun run generate:contracts`);
    stale = true;
  }
}
if (stale) process.exit(1);
