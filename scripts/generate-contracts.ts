import { mkdir, writeFile } from "node:fs/promises";
import { generateClient, generateOpenApi, registry } from "@pirate/contracts";

const root = new URL("../", import.meta.url);
const serverGenerated = new URL("apps/http-worker/src/generated/", root);
const clientGenerated = new URL("packages/api-client/src/generated/", root);
await Promise.all([
  mkdir(serverGenerated, { recursive: true }),
  mkdir(clientGenerated, { recursive: true }),
]);
await writeFile(
  new URL("openapi.json", serverGenerated),
  `${JSON.stringify(generateOpenApi(registry), null, 2)}\n`,
);
await writeFile(new URL("client.ts", clientGenerated), generateClient(registry));
await writeFile(
  new URL("route-table.ts", serverGenerated),
  `// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import { generateRouteTable, registry } from "@pirate/contracts";

export const routeTable = generateRouteTable(registry);
export { registry };
`,
);
