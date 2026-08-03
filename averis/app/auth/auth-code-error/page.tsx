import { ButtonLink } from "@/components/ui";
import { Wordmark } from "@/components/brand/Logo";

export const metadata = { title: "Sign-in link problem" };

export default function AuthCodeErrorPage() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <div className="flex justify-center">
          <Wordmark />
        </div>
        <h1 className="mt-8 text-[24px] font-semibold">We couldn&rsquo;t complete that sign-in</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
          The link you used has expired or was already used. Sign-in links can only be used once.
          Start again and we&rsquo;ll send a fresh one.
        </p>
        <div className="mt-7 flex justify-center gap-3">
          <ButtonLink href="/login">Back to sign in</ButtonLink>
          <ButtonLink href="/" variant="secondary">Go to homepage</ButtonLink>
        </div>
      </div>
    </main>
  );
}
