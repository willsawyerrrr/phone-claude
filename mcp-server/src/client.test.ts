import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { cancelCall, pollForAnswer, startCall } from "./client.js";

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type Handler = (
  request: RecordedRequest,
  response: ServerResponse,
) => void | Promise<void>;

interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function startFakeServer(handler: Handler): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      requests.push(recorded);
      void handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const okHandler: Handler = (_request, response) => json(response, 200, {});

function failWith(status: number, body = ""): Handler {
  return (_request, response) => {
    response.writeHead(status);
    response.end(body);
  };
}

describe("client", () => {
  let pipeline: FakeServer;
  let ari: FakeServer;
  let config: Config;

  async function startServers(
    pipelineHandler: Handler = okHandler,
    ariHandler: Handler = okHandler,
  ): Promise<void> {
    pipeline = await startFakeServer(pipelineHandler);
    ari = await startFakeServer(ariHandler);
    config = {
      pipelineUrl: pipeline.url,
      ariUrl: ari.url,
      ariUsername: "phone-claude",
      ariPassword: "secret",
      sipEndpoint: "phone",
      dialplanContext: "ask-by-phone",
      dialplanExtension: "700",
      pollIntervalMs: 0,
      maxWaitMs: 200,
    };
  }

  async function restartServers(
    pipelineHandler?: Handler,
    ariHandler?: Handler,
  ): Promise<void> {
    await pipeline.close();
    await ari.close();
    await startServers(pipelineHandler, ariHandler);
  }

  beforeEach(async () => {
    await startServers();
  });

  afterEach(async () => {
    await pipeline.close();
    await ari.close();
  });

  describe("startCall", () => {
    it("registers the prompt with the pipeline, then originates via ARI", async () => {
      const callId = await startCall(config, "Deploy?", "Staging is green");

      const [register] = pipeline.requests;
      expect(register).toMatchObject({ method: "POST", path: "/calls" });
      expect(JSON.parse(register!.body)).toEqual({
        callId,
        question: "Deploy?",
        context: "Staging is green",
      });

      const [originate] = ari.requests;
      const url = new URL(originate!.path, "http://ari");
      expect(originate!.method).toBe("POST");
      expect(url.pathname).toBe("/ari/channels");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        endpoint: "PJSIP/phone",
        context: "ask-by-phone",
        extension: "700",
        priority: "1",
        channelId: callId,
      });
      expect(JSON.parse(originate!.body)).toEqual({
        variables: { CALL_ID: callId },
      });
      expect(originate!.headers.authorization).toBe(
        `Basic ${Buffer.from("phone-claude:secret").toString("base64")}`,
      );
    });

    it("uses a UUID as the call ID, distinct per call", async () => {
      const first = await startCall(config, "One?");
      const second = await startCall(config, "Two?");

      expect(first).toMatch(UUID_PATTERN);
      expect(second).toMatch(UUID_PATTERN);
      expect(first).not.toBe(second);
    });

    it("registers the prompt before originating the call", async () => {
      const order: string[] = [];
      await restartServers(
        (_request, response) => {
          order.push("pipeline");
          json(response, 200, {});
        },
        (_request, response) => {
          order.push("ari");
          json(response, 200, {});
        },
      );

      await startCall(config, "Deploy?");

      expect(order).toEqual(["pipeline", "ari"]);
    });

    it("throws without originating when the pipeline rejects the prompt", async () => {
      await restartServers(failWith(500, "boom"));

      await expect(startCall(config, "Deploy?")).rejects.toThrow(
        /Failed to register call \(500\): boom/,
      );
      expect(ari.requests).toHaveLength(0);
    });

    it("cancels the registered prompt and throws when ARI rejects the originate", async () => {
      await restartServers(okHandler, failWith(400, "no such endpoint"));

      await expect(startCall(config, "Deploy?")).rejects.toThrow(
        /Failed to originate call \(400\): no such endpoint/,
      );

      expect(pipeline.requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: expect.stringMatching(/^\/calls\/.+\/cancel$/),
        }),
      );
    });
  });

  describe("pollForAnswer", () => {
    it("returns the answer once the call is answered", async () => {
      await restartServers((_request, response) =>
        json(response, 200, { status: "answered", answer: "Yes" }),
      );

      await expect(pollForAnswer(config, "call-1")).resolves.toBe("Yes");
      expect(pipeline.requests[0]).toMatchObject({
        method: "GET",
        path: "/calls/call-1",
      });
    });

    it("keeps polling while the call is pending", async () => {
      let polls = 0;
      await restartServers((_request, response) => {
        polls += 1;
        json(
          response,
          200,
          polls < 3
            ? { status: "pending" }
            : { status: "answered", answer: "Later" },
        );
      });

      await expect(pollForAnswer(config, "call-1")).resolves.toBe("Later");
      expect(polls).toBe(3);
    });

    it("throws with the reported error when the call fails", async () => {
      await restartServers((_request, response) =>
        json(response, 200, { status: "failed", error: "No answer" }),
      );

      await expect(pollForAnswer(config, "call-1")).rejects.toThrow(
        "No answer",
      );
    });

    it("throws when polling the pipeline fails", async () => {
      await restartServers(failWith(404));

      await expect(pollForAnswer(config, "call-1")).rejects.toThrow(
        /Failed to poll call status \(404\)/,
      );
    });

    it("times out if the call stays pending past maxWaitMs", async () => {
      await restartServers((_request, response) =>
        json(response, 200, { status: "pending" }),
      );

      await expect(pollForAnswer(config, "call-1")).rejects.toThrow(
        /Timed out/,
      );
    });

    it("cancels the call before reporting a timeout", async () => {
      await restartServers((_request, response) =>
        json(response, 200, { status: "pending" }),
      );

      await expect(pollForAnswer(config, "call-1")).rejects.toThrow(
        /Timed out/,
      );

      expect(ari.requests).toContainEqual(
        expect.objectContaining({
          method: "DELETE",
          path: "/ari/channels/call-1",
        }),
      );
      expect(pipeline.requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: "/calls/call-1/cancel",
        }),
      );
    });
  });

  describe("cancelCall", () => {
    it("hangs up the ARI channel and cancels the pipeline call", async () => {
      await cancelCall(config, "call-1");

      expect(ari.requests).toHaveLength(1);
      expect(ari.requests[0]).toMatchObject({
        method: "DELETE",
        path: "/ari/channels/call-1",
      });
      expect(ari.requests[0]!.headers.authorization).toMatch(/^Basic /);
      expect(pipeline.requests).toHaveLength(1);
      expect(pipeline.requests[0]).toMatchObject({
        method: "POST",
        path: "/calls/call-1/cancel",
      });
    });

    it("still cancels the pipeline call when the channel is already gone", async () => {
      await restartServers(okHandler, failWith(404));

      await expect(cancelCall(config, "call-1")).resolves.toBeUndefined();
      expect(pipeline.requests).toHaveLength(1);
    });

    it("swallows a network error", async () => {
      await pipeline.close();
      await ari.close();

      await expect(cancelCall(config, "call-1")).resolves.toBeUndefined();
    });
  });
});
