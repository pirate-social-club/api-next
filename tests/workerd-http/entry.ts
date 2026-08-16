import { AuthError } from "@pirate/contracts";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";

const app = createHttpWorker({
  handlers: {
    CastPostVote: () => ({ post: "post_1", value: 1 }),
  },
  authenticate: ({ credentials }) => {
    if (!credentials.authorization.startsWith("Bearer ")) {
      throw new AuthError({ message: "Invalid authorization" });
    }
    return { kind: "user", subject: "workerd-test-user" };
  },
  authorize: ({ input }) => {
    if (input.principal === null) throw new AuthError({ message: "Authentication required" });
  },
});

export default app;
