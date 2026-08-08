import {
  SiteHeader,
  Hero,
  Problem,
  HowItWorks,
  Technology,
  Metrics,
  Impact,
  Architecture,
  Security,
  DemoSection,
  FinalCta,
  SiteFooter,
} from "@/components/marketing/sections";

/**
 * The landing page.
 *
 * Ordered as an argument rather than as a feature list: the gap, the platform
 * that closes it, what it is built from, what can be verified, who it is for,
 * how it fits together, and how access is controlled.
 *
 * Every section is static — no data fetching, no session lookup — so this is
 * the one route in the application that prerenders. It is also the page most
 * likely to be opened on a phone on a conference floor.
 */
export default function LandingPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero />
        <Problem />
        <HowItWorks />
        <Technology />
        <Metrics />
        <Impact />
        <Architecture />
        <Security />
        <DemoSection />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
