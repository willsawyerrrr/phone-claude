import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import type { RequestHandler, Router } from "express";
import {
  EncryptJWT,
  createRemoteJWKSet,
  jwtDecrypt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthConfig } from "./config.js";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

const GOOGLE_STATE_TTL_S = 10 * 60;
const CODE_TTL_S = 5 * 60;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

/**
 * The redirect URIs a client may register: Claude's connector callbacks, or
 * a loopback URL (Claude Code). Any other would let a crafted authorize link
 * send the allowed account's code to someone else.
 */
const CLAUDE_CALLBACKS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Upstream Google dependencies, injectable for tests. */
export interface GoogleDeps {
  fetch: typeof fetch;
  jwks: JWTVerifyGetKey;
}

type Kind = "client" | "google" | "code" | "access" | "refresh";

/**
 * Seals claims into an encrypted JWT (`dir`/`A256GCM`, key derived from
 * `AUTH_SECRET`) tagged with its `kind`, so clients, codes and tokens need no
 * store and survive restarts.
 */
export function createSealer(authSecret: string) {
  const key = new Uint8Array(
    hkdfSync("sha256", authSecret, "", "phone-claude-mcp-auth", 32),
  );
  return {
    seal(kind: Kind, claims: JWTPayload, ttlS?: number): Promise<string> {
      const jwt = new EncryptJWT({ ...claims, kind })
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .setIssuedAt()
        .setJti(randomUUID());
      if (ttlS) jwt.setExpirationTime(`${ttlS}s`);
      return jwt.encrypt(key);
    },
    /** The claims, or `undefined` if `token` is invalid, expired or another kind. */
    async open<T>(
      kind: Kind,
      token: string,
    ): Promise<(T & JWTPayload) | undefined> {
      try {
        const { payload } = await jwtDecrypt(token, key);
        return payload.kind === kind ? (payload as T & JWTPayload) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

type StoredClient = Omit<OAuthClientInformationFull, "client_id">;

interface PendingAuthorization {
  cid: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
}

interface GoogleState extends PendingAuthorization {
  nonce: string;
  verifier: string;
}

interface Grant {
  cid: string;
  sub: string;
  scopes: string[];
}

type CodeClaims = PendingAuthorization & Grant;

/** A short, fixed-size handle for a client ID, which is itself a sealed token. */
function clientHash(clientId: string): string {
  return createHash("sha256").update(clientId).digest("base64url");
}

function isAllowedRedirect(uri: string): boolean {
  if (CLAUDE_CALLBACKS.has(uri)) return true;
  const url = new URL(uri);
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * `mcp-server` as its own OAuth 2.1 authorization server, delegating sign-in
 * to Google and admitting only `allowedEmail`. Returns the router serving the
 * OAuth endpoints and metadata (mount at the app root) and the middleware
 * guarding `/mcp`.
 */
export function createAuth(
  config: AuthConfig,
  google: GoogleDeps = { fetch, jwks: createRemoteJWKSet(GOOGLE_JWKS_URL) },
): { router: Router; requireAuth: RequestHandler } {
  const { seal, open } = createSealer(config.authSecret);
  const resourceUrl = new URL("/mcp", config.publicUrl);
  const googleRedirectUri = new URL(GOOGLE_CALLBACK_PATH, config.publicUrl)
    .href;
  /** Redeemed codes' `jti`s until they expire, making codes single-use. */
  const usedCodes = new Map<string, number>();

  function checkResource(resource: URL | undefined): void {
    if (resource && resource.href.replace(/\/$/, "") !== resourceUrl.href) {
      throw new InvalidTargetError(`Unknown resource: ${resource.href}`);
    }
  }

  async function openCode(
    client: OAuthClientInformationFull,
    code: string,
  ): Promise<CodeClaims & JWTPayload> {
    const claims = await open<CodeClaims>("code", code);
    if (!claims || claims.cid !== clientHash(client.client_id)) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return claims;
  }

  async function issueTokens({
    cid,
    sub,
    scopes,
  }: Grant): Promise<OAuthTokens> {
    const grant = { cid, sub, scopes };
    return {
      access_token: await seal(
        "access",
        { ...grant, aud: resourceUrl.href },
        ACCESS_TTL_S,
      ),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: await seal("refresh", grant, REFRESH_TTL_S),
      scope: scopes.join(" ") || undefined,
    };
  }

  const provider: OAuthServerProvider = {
    clientsStore: {
      async getClient(clientId) {
        const claims = await open<{ client: StoredClient }>("client", clientId);
        return claims && { ...claims.client, client_id: clientId };
      },
      async registerClient(client) {
        if (!client.redirect_uris.every(isAllowedRedirect)) {
          throw new InvalidClientMetadataError(
            "redirect_uris must be Claude's connector callback or a loopback URL",
          );
        }
        const stored: StoredClient = {
          redirect_uris: client.redirect_uris,
          token_endpoint_auth_method: client.token_endpoint_auth_method,
          grant_types: client.grant_types,
          response_types: client.response_types,
          client_name: client.client_name,
          scope: client.scope,
          client_secret: client.client_secret,
          client_secret_expires_at: client.client_secret_expires_at,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        return {
          ...stored,
          client_id: await seal("client", { client: stored }),
        };
      },
    },

    async authorize(client, params, res) {
      checkResource(params.resource);
      const nonce = randomBytes(16).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const state: GoogleState = {
        cid: clientHash(client.client_id),
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scopes: params.scopes ?? [],
        nonce,
        verifier,
      };
      const url = new URL(GOOGLE_AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: config.googleClientId,
        redirect_uri: googleRedirectUri,
        response_type: "code",
        scope: "openid email",
        state: await seal("google", { ...state }, GOOGLE_STATE_TTL_S),
        nonce,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        login_hint: config.allowedEmail,
      }).toString();
      res.redirect(302, url.href);
    },

    async challengeForAuthorizationCode(client, code) {
      return (await openCode(client, code)).codeChallenge;
    },

    async exchangeAuthorizationCode(
      client,
      code,
      _verifier,
      redirectUri,
      resource,
    ) {
      const claims = await openCode(client, code);
      const now = Date.now() / 1000;
      for (const [jti, exp] of usedCodes) if (exp < now) usedCodes.delete(jti);
      if (usedCodes.has(claims.jti!)) {
        throw new InvalidGrantError("Authorization code already used");
      }
      if (redirectUri !== undefined && redirectUri !== claims.redirectUri) {
        throw new InvalidGrantError("redirect_uri does not match");
      }
      checkResource(resource);
      usedCodes.set(claims.jti!, claims.exp!);
      return issueTokens(claims);
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const claims = await open<Grant>("refresh", refreshToken);
      if (
        !claims ||
        claims.cid !== clientHash(client.client_id) ||
        claims.sub !== config.allowedEmail
      ) {
        throw new InvalidGrantError("Invalid refresh token");
      }
      if (scopes && !scopes.every((scope) => claims.scopes.includes(scope))) {
        throw new InvalidScopeError("Scope exceeds the original grant");
      }
      checkResource(resource);
      return issueTokens({ ...claims, scopes: scopes ?? claims.scopes });
    },

    async verifyAccessToken(token) {
      const claims = await open<Grant & { aud: string }>("access", token);
      if (!claims || claims.sub !== config.allowedEmail) {
        throw new InvalidTokenError("Invalid access token");
      }
      return {
        token,
        clientId: claims.cid,
        scopes: claims.scopes,
        expiresAt: claims.exp,
        resource: new URL(claims.aud),
      };
    },
  };

  /** The Google account's email if its ID token is valid and verified. */
  async function googleEmail(
    code: string,
    state: GoogleState,
  ): Promise<string | undefined> {
    const response = await google.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: googleRedirectUri,
        code_verifier: state.verifier,
      }),
    });
    if (!response.ok) return undefined;
    const { id_token: idToken } = (await response.json()) as {
      id_token?: string;
    };
    if (!idToken) return undefined;
    const { payload } = await jwtVerify(idToken, google.jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: config.googleClientId,
    });
    if (payload.nonce !== state.nonce || payload.email_verified !== true) {
      return undefined;
    }
    return typeof payload.email === "string"
      ? payload.email.toLowerCase()
      : undefined;
  }

  const router = express.Router();
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: resourceUrl,
      resourceName: "Phone Claude",
      // Client IDs are sealed; secrets never expire, as no store can rotate them.
      clientRegistrationOptions: {
        clientIdGeneration: false,
        clientSecretExpirySeconds: 0,
      },
    }),
  );
  router.get(GOOGLE_CALLBACK_PATH, async (req, res) => {
    const { code, state } = req.query;
    const pending =
      typeof state === "string"
        ? await open<GoogleState>("google", state)
        : undefined;
    if (!pending) {
      res.status(400).type("text").send("Invalid or expired sign-in request.");
      return;
    }
    const redirect = new URL(pending.redirectUri);
    if (pending.state) redirect.searchParams.set("state", pending.state);
    if (typeof code !== "string") {
      redirect.searchParams.set("error", "access_denied");
      res.redirect(302, redirect.href);
      return;
    }
    const email = await googleEmail(code, pending).catch(() => undefined);
    if (email !== config.allowedEmail) {
      res.status(403).type("text").send("This Google account is not allowed.");
      return;
    }
    const claims: CodeClaims = {
      cid: pending.cid,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      sub: email,
    };
    redirect.searchParams.set(
      "code",
      await seal("code", { ...claims }, CODE_TTL_S),
    );
    res.redirect(302, redirect.href);
  });

  return {
    router,
    requireAuth: requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
      expectedResource: resourceUrl,
    }),
  };
}
