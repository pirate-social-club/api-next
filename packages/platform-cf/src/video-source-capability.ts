export async function videoSourceCapabilityDigest(capability: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability))),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}
