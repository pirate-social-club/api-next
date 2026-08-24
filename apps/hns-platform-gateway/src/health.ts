export type HnsStaticPlatformGatewayHealthService = Readonly<{
  handle: (target: string) => Promise<Response>;
}>;

export function makeHnsStaticPlatformGatewayHealthService(input: {
  ready: () => Promise<boolean> | boolean;
}): HnsStaticPlatformGatewayHealthService {
  return Object.freeze({
    handle: async (target) => {
      if (target === "/livez") return new Response(null, { status: 204 });
      if (target !== "/readyz") return new Response(null, { status: 404 });
      try {
        return new Response(null, { status: (await input.ready()) ? 204 : 503 });
      } catch {
        return new Response(null, { status: 503 });
      }
    },
  });
}
