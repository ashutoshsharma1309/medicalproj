import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "./db";
import type { Role } from "@prisma/client";

const COOKIE = "meridian_session";
const secret = () =>
  new TextEncoder().encode(process.env.AUTH_SECRET ?? "meridian-insecure-dev");

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  title?: string | null;
};

export async function createSession(user: SessionUser, opts?: { remember?: boolean }) {
  const maxAge = opts?.remember ? 60 * 60 * 24 * 30 : 60 * 60 * 12;
  const token = await new SignJWT({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    title: user.title ?? null,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(opts?.remember ? "30d" : "12h")
    .sign(secret());

  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });
}

export async function destroySession() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function getSession(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      id: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as Role,
      title: (payload.title as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/** API-route guard. Returns the session or a 401/403 response. */
export async function requireRole(
  ...roles: Role[]
): Promise<{ user: SessionUser } | { error: NextResponse }> {
  const user = await getSession();
  if (!user) {
    return {
      error: NextResponse.json(
        { error: "Not authenticated. Sign in to continue." },
        { status: 401 },
      ),
    };
  }
  if (roles.length > 0 && !roles.includes(user.role)) {
    return {
      error: NextResponse.json(
        { error: "Your role does not permit this action." },
        { status: 403 },
      ),
    };
  }
  return { user };
}

export async function verifyCredentials(email: string, password: string) {
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
