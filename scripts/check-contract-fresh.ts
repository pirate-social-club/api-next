import { readFile } from "node:fs/promises";
import { generateClient, generateOpenApi, registry } from "@pirate/contracts";

const generated = new URL("../apps/http-worker/src/generated/", import.meta.url);
const expected = new Map([
  ["openapi.json", `${JSON.stringify(generateOpenApi(registry), null, 2)}\n`],
  ["client.ts", generateClient(registry)],
  [
    "route-table.ts",
    `// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import { generateRouteTable, registry } from "@pirate/contracts";

export const routeTable = generateRouteTable(registry);
export { registry };
`,
  ],
]);
let stale = false;
for (const [name, value] of expected) {
  const actual = await readFile(new URL(name, generated), "utf8").catch(() => "");
  if (actual !== value) {
    console.error(`Generated contract is stale: ${name}. Run bun run generate:contracts`);
    stale = true;
  }
}
if (stale) process.exit(1);
