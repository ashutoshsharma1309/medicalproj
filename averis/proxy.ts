import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Next.js 16 renamed the `middleware` file convention to `proxy`.
 *
 * This refreshes Supabase auth tokens and gates protected routes. It is
 * defence in depth only — Server Actions are POSTs to their host route, so a
 * matcher change could silently drop coverage. Every action and protected page
 * re-authorizes independently via `requireUser()`.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every path except static assets and metadata files:
     * - _next/static, _next/image
     * - favicon and common image/font extensions
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
