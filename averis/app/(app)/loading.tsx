/**
 * The loading state for every signed-in page.
 *
 * All of them are `force-dynamic` and most run several RLS-scoped queries, so
 * there is a real gap between navigation and first paint. Without this file
 * Next.js shows the *previous* page during that gap — which on a monitoring
 * product means a clinician clicking from one patient to another sees the
 * first patient's vitals under the second patient's name until the data
 * arrives.
 *
 * That is the failure this file exists to prevent, and it is worth more than
 * the polish: a skeleton is unambiguous about having no data yet.
 */
export default function Loading() {
  return (
    <div className="space-y-7" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <header>
        <div className="h-3 w-24 rounded bg-wash" />
        <div className="mt-3 h-6 w-64 rounded bg-wash" />
      </header>

      {[0, 1].map((card) => (
        <div key={card} className="rounded-lg border border-rule bg-surface">
          <div className="border-b border-rule px-6 py-4">
            <div className="h-3 w-20 rounded bg-wash" />
            <div className="mt-2.5 h-4 w-44 rounded bg-wash" />
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-5 px-6 py-5 sm:grid-cols-4">
            {[0, 1, 2, 3].map((cell) => (
              <div key={cell}>
                <div className="h-2.5 w-14 rounded bg-wash" />
                <div className="mt-2 h-5 w-16 rounded bg-wash" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
