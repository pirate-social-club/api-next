/** Host-side outbound service: native Worker fetch runs before this fixture.
 * Never replace global fetch, and never permit actual network traffic.
 */
type Fixture = {
  token: string;
  jwk: JsonWebKey;
  redirectStage: "none" | "token" | "jwks";
};

let fixture: Fixture | undefined;
let calls: { url: string; method: string; authorization: boolean }[] = [];

export async function telegramOidcOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === "https://telegram-oidc-fixture.test") {
    if (url.pathname === "/configure" && request.method === "POST") {
      fixture = (await request.json()) as Fixture;
      calls = [];
      return Response.json({ configured: true });
    }
    if (url.pathname === "/calls") return Response.json(calls);
  }
  calls.push({
    url: request.url,
    method: request.method,
    authorization: request.headers.has("authorization"),
  });
  if (fixture && url.origin === "https://oauth.telegram.org") {
    const stage =
      url.pathname === "/token"
        ? "token"
        : url.pathname === "/.well-known/jwks.json"
          ? "jwks"
          : undefined;
    if (stage && fixture.redirectStage === stage)
      return new Response(null, {
        status: 302,
        headers: { location: "https://redirect-target.test/steal" },
      });
    if (stage === "token") return Response.json({ id_token: fixture.token });
    if (stage === "jwks") return Response.json({ keys: [fixture.jwk] });
  }
  return new Response("Outbound request refused by test fixture", { status: 503 });
}
