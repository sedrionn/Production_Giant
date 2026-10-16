/**
 * EVE SSO (OAuth2 authorization code flow, "web application" type).
 * Docs: https://developers.eveonline.com/docs/services/sso/
 * Needs EVE_CLIENT_ID / EVE_CLIENT_SECRET from your app on developers.eveonline.com.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { USER_AGENT } from "./client";

export const SSO = {
  authorize: "https://login.eveonline.com/v2/oauth/authorize",
  token: "https://login.eveonline.com/v2/oauth/token",
  metadata: "https://login.eveonline.com/.well-known/oauth-authorization-server",
  issuers: ["https://login.eveonline.com/", "https://login.eveonline.com", "login.eveonline.com"],
};

/** Everything the app reads. Corp scopes need the Director role in game; asked anyway so no re-login later. */
export const SCOPES = [
  "esi-skills.read_skills.v1",
  "esi-characters.read_blueprints.v1",
  "esi-industry.read_character_jobs.v1",
  "esi-assets.read_assets.v1",
  "esi-corporations.read_blueprints.v1",
  "esi-industry.read_corporation_jobs.v1",
  "esi-assets.read_corporation_assets.v1",
];

export interface SsoConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export class SsoConfigError extends Error {}

export function ssoConfig(env: Record<string, string | undefined> = process.env): SsoConfig {
  const clientId = env.EVE_CLIENT_ID?.trim();
  const clientSecret = env.EVE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new SsoConfigError("Не заданы EVE_CLIENT_ID / EVE_CLIENT_SECRET в .env.local (см. README, раздел «Персонажи»)");
  }
  return { clientId, clientSecret, callbackUrl: env.EVE_CALLBACK_URL?.trim() || "http://localhost:3000/api/auth/callback" };
}

export function authorizeUrl(cfg: SsoConfig, state: string, scopes: string[] = SCOPES): string {
  const u = new URL(SSO.authorize);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", cfg.callbackUrl);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token: string;
}

async function tokenRequest(cfg: SsoConfig, body: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetchImpl(SSO.token, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Host: "login.eveonline.com",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`SSO token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as TokenResponse;
}

export const exchangeCode = (cfg: SsoConfig, code: string, f?: typeof fetch) =>
  tokenRequest(cfg, { grant_type: "authorization_code", code }, f);

/** EVE may return a new refresh token; callers must store it if present. */
export const refreshToken = (cfg: SsoConfig, token: string, f?: typeof fetch) =>
  tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: token }, f);

export interface CharacterIdentity {
  characterId: number;
  name: string;
  scopes: string[];
  expiresAt: number;
}

/** sub = "CHARACTER:EVE:<id>" (docs also show "EVE:CHARACTER:<id>" — accept both). */
export function identityFromClaims(claims: JWTPayload & { name?: string; scp?: string | string[] }): CharacterIdentity {
  const m = /^(?:CHARACTER:EVE|EVE:CHARACTER):(\d+)$/.exec(claims.sub ?? "");
  if (!m) throw new Error(`Неожиданный sub в токене: ${claims.sub}`);
  const scp = claims.scp ?? [];
  return {
    characterId: Number(m[1]),
    name: claims.name ?? `#${m[1]}`,
    scopes: Array.isArray(scp) ? scp : [scp],
    expiresAt: (claims.exp ?? 0) * 1000,
  };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Verifies signature (JWKS), issuer, audience and expiry; returns the character. */
export async function verifyAccessToken(cfg: SsoConfig, token: string): Promise<CharacterIdentity> {
  if (!jwks) {
    const meta = (await (await fetch(SSO.metadata, { headers: { "User-Agent": USER_AGENT } })).json()) as { jwks_uri: string };
    jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
  }
  const { payload } = await jwtVerify(token, jwks, { issuer: SSO.issuers, audience: [cfg.clientId, "EVE Online"] });
  return identityFromClaims(payload);
}
