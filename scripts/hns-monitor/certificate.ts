import { createHash, X509Certificate } from "node:crypto";
import { connect } from "node:tls";

export function inspectPinnedCertificate(raw: Uint8Array, pin: string, now: number): string | null {
  const certificate = new X509Certificate(raw);
  const actualPin = createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (actualPin !== pin) return "certificate_identity_mismatch";
  const from = Date.parse(certificate.validFrom) / 1000;
  const until = Date.parse(certificate.validTo) / 1000;
  if (!Number.isFinite(from) || !Number.isFinite(until) || from > now) return "certificate_invalid";
  return until - now < 14 * 86400 ? "certificate_validity_low" : null;
}

/** This checks the retained SPKI, not public-CA trust or fresh DNSSEC/DANE evidence. */
export async function probePinnedCertificate(
  address: string,
  hostname: string,
  pin: string,
  now: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({
      host: address,
      port: 443,
      servername: hostname,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    const finish = (condition: string | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(condition);
    };
    const timer = setTimeout(() => finish("certificate_observation_unavailable"), 5000);
    socket.once("error", () => finish("certificate_observation_unavailable"));
    socket.once("secureConnect", () => {
      try {
        finish(inspectPinnedCertificate(socket.getPeerCertificate().raw, pin, now));
      } catch {
        finish("certificate_observation_unavailable");
      }
    });
  });
}
