import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { DialogProvider, Toasts } from "@/components/ui";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono-face", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LM Data Universe",
  description: "Relational spreadsheets: tables, formulas, linked views, charts and forms.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} h-full antialiased`}>
      <body className="h-full">
        <DialogProvider>{children}</DialogProvider>
        <Toasts />
      </body>
    </html>
  );
}
