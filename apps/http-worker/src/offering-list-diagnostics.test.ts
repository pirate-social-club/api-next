import { expect, test } from "bun:test";
import {
  OFFERING_LIST_DIAGNOSTIC_HEADER,
  offeringListDiagnosticId,
} from "./offering-list-diagnostics.ts";

const id = "12345678-1234-4234-8234-123456789abc";
const path = "/communities/community_test/handle-offerings?limit=20";
const request = (origin: string, value = id, method = "GET", pathname = path) =>
  new Request(origin + pathname, {
    method,
    headers: { [OFFERING_LIST_DIAGNOSTIC_HEADER]: value },
  });

test("only a valid opt-in staging public-list GET enables database timings", () => {
  expect(offeringListDiagnosticId(request("https://api-next-staging.pirate.sc"))).toBe(id);
  expect(
    offeringListDiagnosticId(new Request("https://api-next-staging.pirate.sc" + path)),
  ).toBeUndefined();
  for (const value of ["", "private-data", id.toUpperCase(), id + "extra"]) {
    expect(
      offeringListDiagnosticId(request("https://api-next-staging.pirate.sc", value)),
    ).toBeUndefined();
  }
  for (const origin of [
    "https://api-next.pirate.sc",
    "https://api-next-staging.pirate.sc.example",
    "https://web-next-staging.pirate.sc",
  ]) {
    expect(offeringListDiagnosticId(request(origin))).toBeUndefined();
  }
  expect(
    offeringListDiagnosticId(request("https://api-next-staging.pirate.sc", id, "POST")),
  ).toBeUndefined();
  expect(
    offeringListDiagnosticId(request("https://api-next-staging.pirate.sc", id, "GET", "/users/me")),
  ).toBeUndefined();
});
