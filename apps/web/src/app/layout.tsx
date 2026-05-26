import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "paperlesspaper Art",
  description: "Searchable artwork catalog for paperlesspaper.",
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
