import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { authorizeUrl, ssoConfig } from "@/esi/sso";

/** Starts EVE SSO: redirects to login.eveonline.com with a one-time state in a cookie. */
export async function GET(req: Request) {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    const res = NextResponse.redirect(authorizeUrl(ssoConfig(), state));
    res.cookies.set("pg_sso_state", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
    return res;
  } catch (e) {
    return NextResponse.redirect(new URL(`/characters?error=${encodeURIComponent((e as Error).message)}`, new URL(req.url).origin));
  }
}
