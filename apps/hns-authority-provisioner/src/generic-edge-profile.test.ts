import { expect, test } from "bun:test";

const productionGeneralSpki = "5c8ddd3dbf63dbab698c726708b06177adda4a21416c675197f97e3b27ab20d8";
const jazleeuwSpecificSpki = "e5dd96b162d67af3016c1db8c19108dd93b5419c7c8eecc7e36c55f98f2d3f08";

test("pins new root TLSA records to the general production gateway certificate", async () => {
  const environment = await Bun.file(
    new URL("../ops/env/hns-authority-provisioner.env.example", import.meta.url),
  ).text();
  expect(environment).toContain(`HNS_AUTHORITY_SHARED_TLSA=3 1 1 ${productionGeneralSpki}`);
  expect(environment).not.toContain(jazleeuwSpecificSpki);
});
