import type { Metadata, Viewport } from "next";
import { Libre_Franklin, Source_Sans_3, DM_Mono } from "next/font/google";
import "./globals.css";

const libreFranklin = Libre_Franklin({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-libre-franklin",
  display: "swap",
});

const sourceSans = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-source-sans",
  display: "swap",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "AVERIS — Your intelligent healthcare journey starts here",
    template: "%s · AVERIS",
  },
  description:
    "AVERIS helps patients organize their health information and create a personalized healthcare profile — a single, secure health identity you own.",
  applicationName: "AVERIS",
  authors: [{ name: "AVERIS" }],
  keywords: [
    "AVERIS",
    "health profile",
    "patient portal",
    "digital health identity",
    "healthcare platform",
  ],
  openGraph: {
    title: "AVERIS — Your intelligent healthcare journey starts here",
    description:
      "Organize your health information and create a personalized healthcare profile you control.",
    siteName: "AVERIS",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0b2229",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${libreFranklin.variable} ${sourceSans.variable} ${dmMono.variable}`}
      >
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
