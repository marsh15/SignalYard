import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signal Yard",
  description: "Agent operations console for protocol evaluation and chaos evidence."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
