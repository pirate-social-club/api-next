import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflareApi } from "./cloudflare-api.mjs";
import { receiptEvents } from "./receipt-evidence.mjs";
import { isolatedWorkers } from "./worker-plan.mjs";

/** Subscribe before enabling rewards. Disconnects fail closed and never reconnect silently. */
export async function subscribeJobsReceipts(directory, dependencies = {}) {
  const api = dependencies.api ?? cloudflareApi;
  const Socket = dependencies.Socket ?? WebSocket;
  const base = `/workers/scripts/${isolatedWorkers.jobs}/tails`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = resolve(directory, "receipt-observer.json");
  const output = resolve(directory, "receipt-observations.jsonl");
  const capture = {
    worker: isolatedWorkers.jobs,
    outcome: "connecting",
    connectedAt: null,
    expiresAt: null,
    subscriptionGaps: 0,
    parseFailures: 0,
    events: [],
  };
  const save = () =>
    writeFileSync(
      metadata,
      `${JSON.stringify(
        {
          ...capture,
          events: capture.events.length,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  // Refuse reuse of an evidence path; a retry cannot overwrite a failed subscription.
  writeFileSync(output, "", { flag: "wx", mode: 0o600 });
  save();
  let socket,
    tailId,
    heartbeat,
    expiry,
    stopping = false,
    pending = Promise.resolve();
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      stopping = true;
      clearInterval(heartbeat);
      clearTimeout(expiry);
      socket?.close();
      await pending;
      if (tailId) {
        try {
          await api(`${base}/${tailId}`, { method: "DELETE" });
          capture.tailDeletionSucceeded = true;
        } catch {
          capture.tailDeletionSucceeded = false;
        }
      }
      capture.closedAt = new Date().toISOString();
      capture.outcome =
        capture.subscriptionGaps || capture.parseFailures || capture.tailDeletionSucceeded !== true
          ? "capture-incomplete"
          : "capture-ended";
      save();
      return capture;
    })();
    return closePromise;
  };
  try {
    const tail = await api(base, {
      method: "POST",
      body: JSON.stringify({ filters: [{ query: "megapot_receipt_read" }] }),
    });
    if (typeof tail.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(tail.id))
      throw new Error("Receipt subscription identity unavailable");
    tailId = tail.id;
    const url = new URL(tail.url);
    const remaining = Date.parse(tail.expires_at) - Date.now();
    if (url.protocol !== "wss:" || !Number.isFinite(remaining) || remaining <= 30_000)
      throw new Error("Receipt subscription lifetime unavailable");
    capture.expiresAt = tail.expires_at;
    socket = new Socket(tail.url, "trace-v1");
    const fail = () => {
      if (stopping) return;
      capture.subscriptionGaps++;
      capture.outcome = "capture-incomplete";
      save();
      void close();
    };
    socket.addEventListener("message", (message) => {
      pending = pending.then(async () => {
        try {
          const text =
            message.data instanceof Blob
              ? await message.data.text()
              : typeof message.data === "string"
                ? message.data
                : Buffer.from(message.data).toString();
          for (const event of receiptEvents(JSON.parse(text))) {
            appendFileSync(output, `${JSON.stringify(event)}\n`);
            capture.events.push(event);
          }
        } catch {
          capture.parseFailures++;
          capture.outcome = "capture-incomplete";
        }
        save();
      });
    });
    socket.addEventListener("error", fail);
    socket.addEventListener("close", fail);
    await new Promise((accept, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Receipt subscription connection timeout")),
        20_000,
      );
      const refuse = () => {
        clearTimeout(timeout);
        reject(new Error("Receipt subscription connection failed"));
      };
      socket.addEventListener("error", refuse, { once: true });
      socket.addEventListener("close", refuse, { once: true });
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          socket.removeEventListener("error", refuse);
          socket.removeEventListener("close", refuse);
          socket.send(JSON.stringify({ debug: false }));
          capture.connectedAt = new Date().toISOString();
          capture.outcome = "subscribed";
          save();
          accept();
        },
        { once: true },
      );
    });
    heartbeat = setInterval(() => {
      if (typeof socket.ping === "function") socket.ping();
    }, 10_000);
    expiry = setTimeout(fail, remaining);
    return { capture, close, flush: () => pending };
  } catch {
    capture.subscriptionGaps++;
    await close();
    // Never include the tail URL, token or provider response in an error.
    throw new Error("Isolated jobs receipt subscription failed; credentials suppressed");
  }
}
