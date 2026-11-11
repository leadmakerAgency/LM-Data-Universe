import { ShareLinkLanding } from "@/components/ShareLinkLanding";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareLinkLanding token={token} />;
}
