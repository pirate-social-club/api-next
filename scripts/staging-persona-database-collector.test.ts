import { expect, test } from "bun:test";
import {
  isDatabaseReconnectDenial,
  probeDeniedRuntimeReconnect,
} from "./staging-persona-database-collector.ts";

test("reconnect evidence excludes bad credentials, network outages and timeouts", () => {
  for (const code of ["42501", "28000"]) expect(isDatabaseReconnectDenial({ code })).toBe(true);
  for (const code of ["28P01", "ECONNREFUSED", "ETIMEDOUT", "57P03", "53300"])
    expect(isDatabaseReconnectDenial({ code })).toBe(false);
  expect(isDatabaseReconnectDenial(new Error("permission denied"))).toBe(false);
  expect(isDatabaseReconnectDenial(null)).toBe(false);
});
test("native reconnect probe requires authenticated TLS before any connection", async () => {
  for (const value of [
    "postgres://runtime:private@localhost/db",
    "postgres://runtime:private@localhost/db?sslmode=require",
    "https://localhost/?sslmode=verify-full",
  ]) {
    await expect(probeDeniedRuntimeReconnect(value)).rejects.toThrow("database_probe_tls_required");
  }
});
