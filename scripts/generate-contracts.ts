import { mkdir, writeFile } from "node:fs/promises";
import { generateClient, generateOpenApi, registry } from "@pirate/contracts";

const root = new URL("../", import.meta.url);
const generated = new URL("apps/http-worker/src/generated/", root);
await mkdir(generated, { recursive: true });
await writeFile(
  new URL("openapi.json", generated),
  `${JSON.stringify(generateOpenApi(registry), null, 2)}\n`,
);
await writeFile(new URL("client.ts", generated), generateClient(registry));
await writeFile(
  new URL("route-table.ts", generated),
  `// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import { generateRouteTable, registry } from "@pirate/contracts";

export const routeTable = generateRouteTable(registry);
export { registry };
`,
);
