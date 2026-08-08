import Link from "next/link";

/**
 * 404.
 *
 * Reached by a mistyped URL and — more often on this application — by
 * `notFound()` in a page whose RLS-scoped query returned nothing. That is
 * deliberate: a clinician opening a patient they are not assigned to, or a
 * caregiver whose access was revoked, gets this page rather than "access
 * denied", because a denial confirms the record exists.
 *
 * So the wording avoids claiming the thing does not exist. It says AVERIS
 * cannot show it, which is true in both cases.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center px-6 py-12">
      <p className="eyebrow">Not found</p>
      <h1 className="mt-2 text-[22px] font-semibold leading-tight">
        AVERIS cannot show this page
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
        The address may be wrong, or this may be something your account does not have access
        to. If someone shared a link with you, ask them to check it is still current.
      </p>
      <div className="mt-6">
        <Link href="/dashboard" className="btn btn-primary">
          Back to your dashboard
        </Link>
      </div>
    </main>
  );
}
