import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Libetario · Team workspace", template: "%s · Libetario" },
  description:
    "Private employee workspace for Libetario Digital Marketing Services",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
