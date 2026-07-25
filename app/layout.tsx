import type { Metadata, Viewport } from "next";
import "./globals.css";
import { GoogleAnalytics } from "./GoogleAnalytics";
import { Analytics } from "@vercel/analytics/next";

export const metadata: Metadata = {
  title: "Convex Cam",
  description:
    "Turn your camera into a bendable convex mirror. Point, push, and snap.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#deddd7",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <GoogleAnalytics measurementId="G-28QD45W0B7" />
        <Analytics />
      </body>
    </html>
  );
}
