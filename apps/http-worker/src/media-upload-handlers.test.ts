import { describe, expect, test } from "bun:test";
import { AuthError } from "@pirate/contracts";
import {
  type MediaUploadHandlerServices,
  makeMediaUploadHandlers,
} from "./media-upload-handlers.ts";
import type { DecodedRequest, EndpointHandlerResult } from "./transport.ts";

const principal = {
  kind: "user" as const,
  subject: "account_media",
};

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest => ({
  body: { fixture: true },
  params: { communityId: "community_media", submissionId: "submission_media" },
  query: {},
  principal,
  ...overrides,
});

describe("media upload handlers", () => {
  test("delegates every contract route with the authenticated actor and route identity", async () => {
    const observed: Array<Readonly<{ route: string; input: unknown }>> = [];
    const call = (route: string) => (input: unknown) => {
      observed.push({ route, input });
      return { route };
    };
    const services: MediaUploadHandlerServices = {
      reserve: call("reserve"),
      create: call("create"),
      bindTerms: call("terms"),
      bindLyrics: call("lyrics"),
      finalize: call("finalize"),
      get: call("get"),
      bindReference: call("reference"),
      retry: call("retry"),
      cancel: call("cancel"),
      moderate: call("moderate"),
    };
    const handlers = makeMediaUploadHandlers(services);

    const reserve = (await handlers.CreateMediaUploadReservation(
      request(),
    )) as EndpointHandlerResult;
    const create = (await handlers.CreateMediaPostSubmission(request())) as EndpointHandlerResult;
    await handlers.BindMediaPostSubmissionTerms(request());
    await handlers.BindMediaPostSubmissionLyrics(request());
    await handlers.FinalizeMediaPostSubmission(request());
    await handlers.GetMediaPostSubmission(request());
    await handlers.BindMediaPostSubmissionReference(request());
    await handlers.RetryMediaPostSubmission(request());
    await handlers.CancelMediaPostSubmission(request());
    await handlers.ModerateMediaPostSubmission(request());

    expect(reserve).toMatchObject({ status: 201, body: { route: "reserve" } });
    expect(create).toMatchObject({ status: 201, body: { route: "create" } });
    expect(observed.map(({ route }) => route)).toEqual([
      "reserve",
      "create",
      "terms",
      "lyrics",
      "finalize",
      "get",
      "reference",
      "retry",
      "cancel",
      "moderate",
    ]);
    expect(observed[0]?.input).toEqual({
      communityId: "community_media",
      actor: { kind: "user", userId: "account_media" },
      body: { fixture: true },
    });
    expect(observed[5]?.input).toEqual({
      submissionId: "submission_media",
      actor: { kind: "user", userId: "account_media" },
    });
  });

  test("rejects unauthenticated, device, and delegated-agent principals before dispatch", async () => {
    let calls = 0;
    const unavailable = () => {
      calls += 1;
      return null;
    };
    const handlers = makeMediaUploadHandlers({
      reserve: unavailable,
      create: unavailable,
      bindTerms: unavailable,
      bindLyrics: unavailable,
      finalize: unavailable,
      get: unavailable,
      bindReference: unavailable,
      retry: unavailable,
      cancel: unavailable,
      moderate: unavailable,
    });

    await expect(
      handlers.CreateMediaUploadReservation(request({ principal: null })),
    ).rejects.toBeInstanceOf(AuthError);
    expect(() =>
      handlers.GetMediaPostSubmission(
        request({ principal: { kind: "device", subject: "device_media" } }),
      ),
    ).toThrow(AuthError);
    expect(() =>
      handlers.GetMediaPostSubmission(
        request({ principal: { kind: "agent", subject: "agent_media" } }),
      ),
    ).toThrow(AuthError);
    expect(calls).toBe(0);
  });
});
