import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./database.types";

/** Routes that require an authenticated session. */
const PROTECTED_PREFIXES = ["/dashboard", "/onboarding"];

/** Routes a signed-in patient should not see. */
const AUTH_ONLY_PREFIXES = ["/login", "/signup"];

/**
 * Refreshes the Supabase session and gates protected routes.
 *
 * Called from `proxy.ts` (Next.js 16 renamed the `middleware` convention to
 * `proxy`). The refreshed tokens must be written to the outgoing response
 * before it is committed, which is why the Supabase client is constructed
 * against `supabaseResponse` and `getClaims()` is awaited here.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Must run before the response is generated so a completed token refresh
  // can still be written back as Set-Cookie.
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims);

  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAuthOnly = AUTH_ONLY_PREFIXES.some((p) => pathname.startsWith(p));

  if (isProtected && !isSignedIn) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthOnly && isSignedIn) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Auth responses carry Set-Cookie; keep them out of any shared cache.
  supabaseResponse.headers.set("Cache-Control", "private, no-store");

  return supabaseResponse;
}
