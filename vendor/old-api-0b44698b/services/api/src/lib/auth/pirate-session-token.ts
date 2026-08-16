import { calculateJwkThumbprint, exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose"
import { authError, internalError } from "../errors"
import type { Env } from "../../env"

const SESSION_JWT_ALG = "RS256"
const DEFAULT_TTL_SECONDS = 60 * 60
export const DEFAULT_PIRATE_APP_SCOPE = "pirate_app_session"
type SessionJwtKey = Awaited<ReturnType<typeof importPKCS8>>

let cachedPrivateKey: { pem: string; key: SessionJwtKey } | null = null
let cachedPublicKey: { pem: string; key: SessionJwtKey } | null = null

async function getPrivateKey(env: Env): Promise<SessionJwtKey> {
  const pem = String(env.PIRATE_APP_JWT_PRIVATE_KEY || "").trim()
  if (!pem) {
    throw internalError("PIRATE_APP_JWT_PRIVATE_KEY is not configured")
  }
  if (cachedPrivateKey?.pem === pem) {
    return cachedPrivateKey.key
  }
  const key = await importPKCS8(pem, SESSION_JWT_ALG)
  cachedPrivateKey = { pem, key }
  return key
}

async function getPublicKey(env: Env): Promise<SessionJwtKey> {
  const pem = String(env.PIRATE_APP_JWT_PUBLIC_KEY || "").trim()
  if (!pem) {
    throw internalError("PIRATE_APP_JWT_PUBLIC_KEY is not configured")
  }
  if (cachedPublicKey?.pem === pem) {
    return cachedPublicKey.key
  }
  const key = await importSPKI(pem, SESSION_JWT_ALG)
  cachedPublicKey = { pem, key }
  return key
}

export async function mintPirateAccessToken(params: {
  env: Env
  scope?: string
  userId: string
}): Promise<string> {
  const issuer = String(params.env.PIRATE_APP_JWT_ISSUER || "").trim() || "pirate-api"
  const audience = String(params.env.PIRATE_APP_JWT_AUDIENCE || "").trim() || "pirate-app"
  const ttlSecondsRaw = Number(params.env.PIRATE_APP_JWT_TTL_SECONDS || String(DEFAULT_TTL_SECONDS))
  const ttlSeconds = Number.isFinite(ttlSecondsRaw) && ttlSecondsRaw > 0 ? Math.floor(ttlSecondsRaw) : DEFAULT_TTL_SECONDS

  return await new SignJWT({ scope: params.scope?.trim() || DEFAULT_PIRATE_APP_SCOPE })
    .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(params.userId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(await getPrivateKey(params.env))
}

export async function verifyPirateAccessToken(params: {
  env: Env
  token: string
}): Promise<{ scope: string; userId: string }> {
  const issuer = String(params.env.PIRATE_APP_JWT_ISSUER || "").trim() || "pirate-api"
  const audience = String(params.env.PIRATE_APP_JWT_AUDIENCE || "").trim() || "pirate-app"

  const verification = await jwtVerify(params.token, await getPublicKey(params.env), {
    issuer,
    audience,
  }).catch(() => {
    throw authError("Authentication failed")
  })

  if (verification.protectedHeader.typ !== "JWT") {
    throw authError("Authentication failed")
  }

  const { iat, exp } = verification.payload
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (
    typeof iat !== "number"
    || typeof exp !== "number"
    || !Number.isSafeInteger(iat)
    || !Number.isSafeInteger(exp)
    || iat < 0
    || exp <= iat
    || iat > nowSeconds
    || exp <= nowSeconds
  ) {
    throw authError("Authentication failed")
  }

  const userId = typeof verification.payload.sub === "string" ? verification.payload.sub.trim() : ""
  if (!userId) {
    throw authError("Authentication failed")
  }

  if (verification.payload.scope !== undefined && typeof verification.payload.scope !== "string") {
    throw authError("Authentication failed")
  }
  const scope = typeof verification.payload.scope === "string" && verification.payload.scope.trim()
    ? verification.payload.scope.trim()
    : DEFAULT_PIRATE_APP_SCOPE

  return { scope, userId }
}

export async function getPirateAccessTokenJwks(params: {
  env: Env
}): Promise<{ keys: Array<Record<string, string>> }> {
  const jwk = await exportJWK(await getPublicKey(params.env))
  jwk.alg = SESSION_JWT_ALG
  jwk.use = "sig"
  jwk.key_ops = ["verify"]
  jwk.kid = await calculateJwkThumbprint(jwk)

  return {
    keys: [jwk as Record<string, string>],
  }
}
