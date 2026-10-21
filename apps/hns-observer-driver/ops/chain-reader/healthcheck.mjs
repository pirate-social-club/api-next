#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import http from "node:http"

const apiKeyFile = process.env.HSD_API_KEY_FILE || "/run/secrets/hsd_api_key"
const apiKey = (await readFile(apiKeyFile, "utf8")).trim()
const expectedNetwork = process.env.HSD_NETWORK || "main"
const port = Number(process.env.HSD_HTTP_PORT || "12037")
const minimumProgress = Number(
  process.env.HSD_HEALTH_MIN_VERIFICATION_PROGRESS || "0.999",
)
const maximumTipAgeSeconds = Number(
  process.env.HSD_HEALTH_MAX_TIP_AGE_SECONDS || "21600",
)
const body = JSON.stringify({ method: "getblockchaininfo", params: [] })

const payload = await new Promise((resolve, reject) => {
  const request = http.request({
    host: "127.0.0.1",
    port,
    path: "/",
    method: "POST",
    timeout: 4_000,
    auth: `x:${apiKey}`,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  }, (response) => {
    let raw = ""
    response.setEncoding("utf8")
    response.on("data", (chunk) => {
      raw += chunk
    })
    response.on("end", () => {
      if (response.statusCode !== 200) {
        reject(new Error(`hsd RPC returned ${response.statusCode}`))
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
  })

  request.on("timeout", () => request.destroy(new Error("hsd RPC timed out")))
  request.on("error", reject)
  request.end(body)
})

const result = payload && typeof payload === "object" ? payload.result : null
const nowSeconds = Math.floor(Date.now() / 1000)
const tipAgeSeconds = result && Number.isSafeInteger(result.mediantime)
  ? nowSeconds - result.mediantime
  : Number.POSITIVE_INFINITY
if (
  !result
  || result.chain !== expectedNetwork
  || !Number.isSafeInteger(result.blocks)
  || !Number.isSafeInteger(result.headers)
  || result.blocks !== result.headers
  || !Number.isFinite(result.verificationprogress)
  || result.verificationprogress < minimumProgress
  || !/^[0-9a-f]{64}$/u.test(result.bestblockhash)
  || tipAgeSeconds < -300
  || tipAgeSeconds > maximumTipAgeSeconds
) {
  throw new Error("hsd observer is not synced on the expected network")
}
