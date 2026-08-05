import { notFound } from "next/navigation";
import {
  MemoryVariants,
  type ManifestAnimation,
} from "@/components/v3/memory-variants/memory-variants";

const ANIMATIONS = new Set(["1", "2", "3"]);

export function generateStaticParams() {
  return [...ANIMATIONS].map((animation) => ({ animation }));
}

export default async function MemoryWordAnimationPage({
  params,
}: {
  params: Promise<{ animation: string }>;
}) {
  const { animation } = await params;
  if (!ANIMATIONS.has(animation)) notFound();

  return <MemoryVariants variant={10} manifestAnimation={Number(animation) as ManifestAnimation} />;
}
