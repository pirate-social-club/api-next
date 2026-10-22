import { expect, test } from "bun:test";

// Exercise operational refusal behavior without requiring a production host.
test("native runtime acceptance refuses stale, redirected and replaced processes", () => {
  const result = Bun.spawnSync(
    ["python3", "-B", "scripts/hns-deployment/verify-native-runtime.test.py"],
    {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
});

test("operational observer RPC matches the maintained private-driver wire contract", async () => {
  const { decodeHnsPrivateDriverRequestV1 } = await import(
    "../packages/application/src/namespace-ownership/hns-private-driver.ts"
  );
  const probe = `
import importlib.util,json
s=importlib.util.spec_from_file_location('native','scripts/hns-deployment/verify-native-runtime.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
requests=[]
class Response:
 status=200
 headers={'Pirate-HNS-Driver-Protocol':'pirate-hns-private-driver-v1','Pirate-HNS-Driver-Upstream-Status':'200'}
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,maximum):return b'{"result":{},"error":null}'
class Opener:
 def open(self,request,timeout):
  requests.append(request.data.decode())
  return Response()
m.urllib.request.build_opener=lambda *args:Opener()
m.observer_rpc('getblockchaininfo',[])
m.observer_rpc('getblockheader',['0'*64,True])
print(json.dumps(requests))
`;
  const result = Bun.spawnSync(["python3", "-B", "-c", probe], {
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  const requests: string[] = JSON.parse(new TextDecoder().decode(result.stdout));
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(
      decodeHnsPrivateDriverRequestV1(new TextEncoder().encode(request)).request.exchange_kind,
    ).toBe("hsd_json_rpc");
  }
});
