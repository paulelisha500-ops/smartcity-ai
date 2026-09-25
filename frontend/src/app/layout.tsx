import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: "SmartCity AI — Urban Planning & Traffic Platform",
  description:
    "Intelligent urban planning and traffic management for the seven emirates — " +
    "real UAE road network, live CCTV integration and costed corridor design.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          Geist is loaded from Google Fonts with a plain <link> rather than
          next/font. next/font validates family names against a list baked into
          the installed Next version, and Geist post-dates 14.2.5 — so the
          idiomatic route fails the build. Preconnecting to both Google Fonts
          hosts keeps the cost of the extra request down.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@300..800&family=Geist+Mono:wght@300..600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-body antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
