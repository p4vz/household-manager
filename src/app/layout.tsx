import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import { PwaRegister } from "@/components/pwa-register";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Household",
  description: "Private household manager",
  robots: { index: false, follow: false },
  // Installable on the parents' phones (public/manifest.webmanifest, public/sw.js).
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Household", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0d9488",
  // Light theme only for now; see the note at the top of globals.css.
  colorScheme: "light",
};

/**
 * Every page renders per request so Next.js can stamp this request's CSP
 * nonce on its scripts (src/core/security/csp.ts). A page prerendered at
 * build time would carry no nonce and its scripts would be blocked.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
