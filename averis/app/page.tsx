import {
  SiteHeader,
  Hero,
  HowItWorks,
  Benefits,
  Security,
  Roadmap,
  FinalCta,
  SiteFooter,
} from "@/components/marketing/sections";

export default function LandingPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero />
        <HowItWorks />
        <Benefits />
        <Security />
        <Roadmap />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
