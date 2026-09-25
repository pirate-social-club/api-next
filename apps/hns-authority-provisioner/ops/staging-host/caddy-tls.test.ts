import { expect, test } from "bun:test";
import template from "../../../hns-platform-gateway/ops/caddy/community-app-reverse-proxy.template.json";
import configuration from "./caddy-tls.json";

test("isolated TLS terminator retains the maintained gateway ingress boundary", () => {
  const server = configuration.apps.http.servers.staging;
  const handlers = server.routes[0]?.handle;
  expect(handlers?.slice(0, 2)).toEqual(template.pre_proxy_handlers);
  expect(handlers?.[2]?.headers).toEqual(template.reverse_proxy_headers);
  expect(handlers?.[2]?.upstreams).toEqual([{ dial: "172.31.254.1:4269" }]);
  expect(server.listen).toEqual([":443"]);
  expect(server.automatic_https).toEqual({ disable: true });
  expect(configuration.admin).toEqual({ disabled: true });
  expect(server.routes).toHaveLength(1);
  expect(handlers).toHaveLength(3);
  expect(configuration.apps.tls.certificates.load_files).toEqual([
    {
      certificate: "/etc/pirate-hns-staging/tls/certificate.pem",
      key: "/etc/pirate-hns-staging/tls/private-key.pem",
      tags: ["staging-fixture"],
    },
  ]);
});
