import Link from "next/link";
import { LoginForm } from "./LoginForm";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { Callout } from "@/components/ui";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <>
      <header>
        <h1 className="text-[26px] font-semibold leading-tight">Sign in to AVERIS</h1>
        <p className="mt-2 text-[14.5px] text-ink-soft">
          New here?{" "}
          <Link href="/signup" className="font-medium text-brand hover:underline">
            Create your profile
          </Link>
        </p>
      </header>

      {error === "google" && (
        <div className="mt-5">
          <Callout tone="critical">
            Google sign-in couldn&rsquo;t be started. Try again, or sign in with your email
            address.
          </Callout>
        </div>
      )}

      <div className="mt-7">
        <GoogleButton label="Continue with Google" />
      </div>

      <div className="my-6 flex items-center gap-4" role="separator">
        <span className="h-px flex-1 bg-rule" />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          or use email
        </span>
        <span className="h-px flex-1 bg-rule" />
      </div>

      <LoginForm />
    </>
  );
}
