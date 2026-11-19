import type { Metadata } from "next";

// Online invoices are private links: never indexed, no referrer sent onwards.
export const metadata: Metadata = {
  title: "Invoice",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function InvoiceLinkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
