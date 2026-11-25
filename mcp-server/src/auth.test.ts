import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
} from "jose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "./app.js";
import type { AuthConfig } from "./config.js";

const PUBLIC_URL = "http://127.0.0.1";
const REDIRECT_URI = "http://localhost:3000/callback";
const authConfig: AuthConfig = {
  publicUrl: new URL(PUBLIC_URL),
  googleClientId: "google-client",
  googleClientSecret: "google-secret",
  allowedEmail: "me@example.com",
  authSecret: "s".repeat(32),
};

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "RS256" }],
});

/** Claims the stubbed Google token endpoint puts in its ID token, beyond `nonce`. */
let idTokenClaims: JWTPayload;
const googleFetch = vi.fn(
  async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(init?.body as URLSearchParams);
    const idToken = await new SignJWT({ ...idTokenClaims, nonce: googleNonce })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer("https://accounts.google.com")
      .setAudience(body.get("client_id")!)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return Response.json({ id_token: idToken });
  },
);
let googleNonce: string | null;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp({ error: new Error("unused") }, new Set(), authConfig, {
    fetch: googleFetch as typeof fetch,
    jwks,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  idTokenClaims = { email: "Me@Example.com", email_verified: true };
});

async function register(
  metadata: Record<string, unknown> = { token_endpoint_auth_method: "none" },
): Promise<Response> {
  return fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], ...metadata }),
  });
}

interface Client {
  client_id: string;
  client_secret?: string;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
}

async function newClient(metadata?: Record<string, unknown>): Promise<Client> {
  return (await (await register(metadata)).json()) as Client;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** Starts authorization and returns Google's authorize URL it redirects to. */
async function authorize(clientId: string, challenge: string): Promise<URL> {
  const url = new URL(`${baseUrl}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    resource: `${PUBLIC_URL}/mcp`,
  }).toString();
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status).toBe(302);
  const google = new URL(response.headers.get("location")!);
  googleNonce = google.searchParams.get("nonce");
  return google;
}

async function callback(google: URL): Promise<Response> {
  const url = new URL(`${baseUrl}/oauth/google/callback`);
  url.search = new URLSearchParams({
    code: "google-code",
    state: google.searchParams.get("state")!,
  }).toString();
  return fetch(url, { redirect: "manual" });
}

async function token(params: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/token`, {
    method: "POST",
    body: new URLSearchParams(params),
  });
}

/** Runs the whole flow for a new public client, returning its ID and tokens. */
async function signIn(): Promise<{ clientId: string; tokens: Tokens }> {
  const { client_id: clientId } = await newClient();
  const { verifier, challenge } = pkce();
  const location = new URL(
    (await callback(await authorize(clientId, challenge))).headers.get(
      "location",
    )!,
  );
  const response = await token({
    grant_type: "authorization_code",
    client_id: clientId,
    code: location.searchParams.get("code")!,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  expect(response.status).toBe(200);
  return { clientId, tokens: (await response.json()) as Tokens };
}

async function listTools(accessToken: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("metadata", () => {
  it("serves the protected resource metadata", async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );

    await expect(response.json()).resolves.toMatchObject({
      resource: `${PUBLIC_URL}/mcp`,
      authorization_servers: [`${PUBLIC_URL}/`],
    });
  });

  it("serves the authorization server metadata", async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );

    await expect(response.json()).resolves.toMatchObject({
      issuer: `${PUBLIC_URL}/`,
      authorization_endpoint: `${PUBLIC_URL}/authorize`,
      token_endpoint: `${PUBLIC_URL}/token`,
      registration_endpoint: `${PUBLIC_URL}/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });
});

describe("/mcp", () => {
  it("rejects a request without a token", async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: "POST" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("rejects an invalid token", async () => {
    const response = await listTools("not-a-token");

    expect(response.status).toBe(401);
  });
});

describe("registration", () => {
  it("registers a client with a self-contained client ID", async () => {
    const response = await register();

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      client_id: expect.any(String),
      redirect_uris: [REDIRECT_URI],
    });
  });

  it("accepts Claude's connector callback", async () => {
    const response = await register({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });

    expect(response.status).toBe(201);
  });

  it("rejects any other redirect URI", async () => {
    const response = await register({
      redirect_uris: ["https://attacker.example/callback"],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_client_metadata",
    });
  });
});

describe("authorization", () => {
  it("redirects to Google with its own state, nonce and PKCE", async () => {
    const { client_id: clientId } = await newClient();

    const google = await authorize(clientId, pkce().challenge);

    expect(`${google.origin}${google.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(google.searchParams)).toMatchObject({
      client_id: "google-client",
      redirect_uri: `${PUBLIC_URL}/oauth/google/callback`,
      response_type: "code",
      scope: "openid email",
      code_challenge_method: "S256",
      nonce: expect.any(String),
      state: expect.any(String),
    });
  });

  it("rejects another resource", async () => {
    const { client_id: clientId } = await newClient();
    const url = new URL(`${baseUrl}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: "https://other.example/mcp",
    }).toString();

    const response = await fetch(url, { redirect: "manual" });

    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("invalid_target");
  });
});

describe("Google callback", () => {
  it("issues a code to the allowed account, case-insensitively", async () => {
    const { client_id: clientId } = await newClient();

    const response = await callback(
      await authorize(clientId, pkce().challenge),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("code")).toEqual(expect.any(String));
  });

  it.each([
    ["another account", { email: "someone@example.com", email_verified: true }],
    ["an unverified email", { email: "me@example.com", email_verified: false }],
  ])("rejects %s", async (_name, claims) => {
    const { client_id: clientId } = await newClient();
    const google = await authorize(clientId, pkce().challenge);
    idTokenClaims = claims;

    const response = await callback(google);

    expect(response.status).toBe(403);
  });

  it("rejects an ID token for another nonce", async () => {
    const { client_id: clientId } = await newClient();
    const google = await authorize(clientId, pkce().challenge);
    googleNonce = "other";

    expect((await callback(google)).status).toBe(403);
  });

  it("rejects an invalid state", async () => {
    const response = await fetch(
      `${baseUrl}/oauth/google/callback?code=x&state=bogus`,
    );

    expect(response.status).toBe(400);
  });
});

describe("token", () => {
  it("exchanges a code once, with the matching PKCE verifier", async () => {
    const { client_id: clientId } = await newClient();
    const { verifier, challenge } = pkce();
    const location = new URL(
      (await callback(await authorize(clientId, challenge))).headers.get(
        "location",
      )!,
    );
    const params = {
      grant_type: "authorization_code",
      client_id: clientId,
      code: location.searchParams.get("code")!,
    };

    const wrong = await token({ ...params, code_verifier: pkce().verifier });
    const right = await token({ ...params, code_verifier: verifier });
    const reused = await token({ ...params, code_verifier: verifier });

    expect(wrong.status).toBe(400);
    expect(right.status).toBe(200);
    await expect(right.json()).resolves.toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });
    expect(reused.status).toBe(400);
  });

  it("authenticates a confidential client with its secret", async () => {
    const { client_id: clientId, client_secret: clientSecret } =
      await newClient({ token_endpoint_auth_method: "client_secret_post" });
    const { verifier, challenge } = pkce();
    const location = new URL(
      (await callback(await authorize(clientId, challenge))).headers.get(
        "location",
      )!,
    );
    const params = {
      grant_type: "authorization_code",
      client_id: clientId,
      code: location.searchParams.get("code")!,
      code_verifier: verifier,
    };

    expect((await token({ ...params, client_secret: "wrong" })).status).toBe(
      400,
    );
    expect(
      (await token({ ...params, client_secret: clientSecret! })).status,
    ).toBe(200);
  });

  it("rotates a refresh token for the client it was issued to", async () => {
    const { clientId, tokens } = await signIn();
    const { client_id: otherClient } = await newClient();

    const other = await token({
      grant_type: "refresh_token",
      client_id: otherClient,
      refresh_token: tokens.refresh_token,
    });
    const response = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });

    expect(other.status).toBe(400);
    expect(response.status).toBe(200);
    const refreshed = (await response.json()) as Tokens;
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect((await listTools(refreshed.access_token)).status).toBe(200);
  });

  it("issues an access token that reaches the tool", async () => {
    const { tokens } = await signIn();

    const response = await listTools(tokens.access_token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { tools: [{ name: "ask_by_phone" }] },
    });
  });

  it("does not accept a refresh token as an access token", async () => {
    const { tokens } = await signIn();

    expect((await listTools(tokens.refresh_token)).status).toBe(401);
  });
});
