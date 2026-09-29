import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Decentraland Drive",
  description: "Upload media to use in your Decentraland scenes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
