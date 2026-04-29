import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PulseCall",
  description: "A simple WebRTC video calling platform built with Next.js.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
