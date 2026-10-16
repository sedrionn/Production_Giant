import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode, ssoConfig } from "@/esi/sso";
import { addCharacterFromTokens, syncCharacter } from "@/server/characters";

/** EVE SSO redirect target (must match the Callback URL of your app on developers.eveonline.com). */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/characters?${q}`, url.origin));
    res.cookies.delete("pg_sso_state");
    return res;
  };
  try {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== req.cookies.get("pg_sso_state")?.value) {
      return back("error=" + encodeURIComponent("Вход не удался: неверный state. Попробуй ещё раз."));
    }
    const id = await addCharacterFromTokens(await exchangeCode(ssoConfig(), code));
    // First sync right away so the character is useful immediately; errors are shown on the page.
    await syncCharacter(id.characterId).catch(() => null);
    return back("added=" + encodeURIComponent(id.name));
  } catch (e) {
    return back("error=" + encodeURIComponent((e as Error).message));
  }
}
