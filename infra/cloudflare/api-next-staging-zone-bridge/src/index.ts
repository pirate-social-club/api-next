const CANONICAL_ORIGIN =
  "https://pirate-http-worker-staging.piratesocialclub.workers.dev";

export default {
  fetch(request: Request): Promise<Response> {
    const incomingUrl = new URL(request.url);
    const targetUrl = new URL(
      `${incomingUrl.pathname}${incomingUrl.search}`,
      CANONICAL_ORIGIN,
    );

    return fetch(new Request(targetUrl, request));
  },
};
