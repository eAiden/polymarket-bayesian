import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polymarket Bayesian",
  description: "Bayesian edge analysis for Polymarket prediction markets resolving within 30 days.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#0a0a0a" />
      </head>
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
