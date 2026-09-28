import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});
const serifDisplay = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-serif-display",
});

export const metadata: Metadata = {
  title: {
    default: "CareBridge — AI-Powered Pre-Consultation Assistant",
    template: "%s · CareBridge",
  },
  description:
    "CareBridge helps you describe your symptoms, answers relevant follow-up questions, and prepares a concise, doctor-ready summary you can share before your consultation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${plexSans.variable} ${plexMono.variable} ${serifDisplay.variable}`}>
        {children}
      </body>
    </html>
  );
}
