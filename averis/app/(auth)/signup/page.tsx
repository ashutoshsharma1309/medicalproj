import Link from "next/link";
import { SignupForm } from "./SignupForm";
import { GoogleButton } from "@/components/auth/GoogleButton";

export const metadata = { title: "Create your profile" };

export default function SignupPage() {
  return (
    <>
      <header>
        <h1 className="text-[26px] font-semibold leading-tight">Create your AVERIS profile</h1>
        <p className="mt-2 text-[14.5px] text-ink-soft">
          Already registered?{" "}
          <Link href="/login" className="font-medium text-brand hover:underline">
            Sign in
          </Link>
        </p>
      </header>

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

      <SignupForm />

      <p className="mt-6 text-[13px] leading-relaxed text-muted">
        Next you&rsquo;ll complete a short health profile. AVERIS is a health information
        platform and does not provide medical advice.
      </p>
    </>
  );
}
