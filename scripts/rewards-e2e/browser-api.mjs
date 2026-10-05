import { isolatedOrigins } from "./worker-plan.mjs";

/** Same-origin app calls keep session and CSRF credentials inside the browser. No retries. */
export async function browserApi(page, path, { method = "GET", body, statuses = [200] } = {}) {
  if (
    new URL(page.url()).origin !== isolatedOrigins.web ||
    !/^\/api\/[a-zA-Z0-9_/-]+$/.test(path) ||
    path.startsWith("/api/auth/")
  )
    throw Error("Isolated browser API path refused");
  return page.evaluate(
    async ({ path, method, body, statuses }) => {
      const headers = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (method !== "GET") {
        const csrf = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("__Host-pirate_csrf="));
        if (!csrf) throw Error("Browser CSRF cookie required");
        headers["x-csrf-token"] = decodeURIComponent(csrf.slice(csrf.indexOf("=") + 1));
      }
      const response = await fetch(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json().catch(() => null);
      if (!statuses.includes(response.status))
        throw Error(
          `App command refused: HTTP ${response.status}, code ${data?.error?.code ?? "unknown"}`,
        );
      return data;
    },
    { path, method, body, statuses },
  );
}
