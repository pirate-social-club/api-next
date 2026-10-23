/** Exact CloudConvert storage origins observed in provider acceptance. Never use
 * suffix matching: uploads and exports must not target an arbitrary subdomain. */
export const CLOUDCONVERT_STORAGE_HOSTS: readonly string[] = [
  "storage.cloudconvert.com",
  "us-east.storage.cloudconvert.com",
  "eu-central.storage.cloudconvert.com",
];
