import { mkdir, writeFile } from "node:fs/promises";
import { endpoints, generateClient, generateOpenApi } from "@pirate/contracts";

const root = new URL("../", import.meta.url);
const generated = new URL("apps/http-worker/src/generated/", root);
await mkdir(generated, { recursive: true });
await writeFile(
  new URL("openapi.json", generated),
  `${JSON.stringify(generateOpenApi(endpoints), null, 2)}\n`,
);
await writeFile(new URL("client.ts", generated), `${generateClient(endpoints)}\n`);
await writeFile(
  new URL("route-table.ts", generated),
  `// GENERATED FILE. DO NOT EDIT.\nimport { endpoints } from "@pirate/contracts";\n\nexport const routeTable = endpoints.map((endpoint) => ({ method: endpoint.method, path: endpoint.path, endpoint }));\nexport { endpoints };\n`,
);
