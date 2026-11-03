"use client";

import { useParams } from "next/navigation";
import { DocScreen } from "@/components/doc/DocScreen";

export default function DocPage() {
  const { docId } = useParams<{ docId: string }>();
  return <DocScreen docId={docId} />;
}
