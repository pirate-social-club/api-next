// Exact HNS host-locator boundary needed by browser admission and HTTP dispatch.
// Verification, key custody, signing and replay authority stay in their owned modules.
export {
  HNS_FORWARDER_HOST_HEADER,
  isCanonicalHnsForwarderHost,
} from "../hns-forwarder-v3.ts";
