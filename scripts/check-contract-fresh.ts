import { readFile } from "node:fs/promises";
import { endpoints, generateClient, generateOpenApi } from "@pirate/contracts";

const generated = new URL("../apps/http-worker/src/generated/", import.meta.url);
const expected = new Map([
  ["openapi.json", `${JSON.stringify(generateOpenApi(endpoints), null, 2)}\n`],
  ["client.ts", `${generateClient(endpoints)}\n`],
  [
    "route-table.ts",
    `// GENERATED FILE. DO NOT EDIT.\nimport { endpoints } from "@pirate/contracts";\n\nexport const routeTable = endpoints.map((endpoint) => ({ method: endpoint.method, path: endpoint.path, endpoint }));\nexport { endpoints };\n`,
  ],
]);
for (const [name, value] of expected) {
  const actual = await readFile(new URL(name, generated), "utf8").catch(() => "");
  if (actual !== value)
    throw new Error(`Generated contract is stale: ${name}. Run bun run generate:contracts`);
}
