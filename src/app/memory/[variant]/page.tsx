import { notFound } from "next/navigation";
import {
  MemoryVariants,
  type MemoryVariant,
} from "@/components/v3/memory-variants/memory-variants";

const VARIANTS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

export function generateStaticParams() {
  return [...VARIANTS].map((variant) => ({ variant }));
}

export default async function MemoryVariantPage({
  params,
}: {
  params: Promise<{ variant: string }>;
}) {
  const { variant } = await params;
  if (!VARIANTS.has(variant)) notFound();

  return <MemoryVariants variant={Number(variant) as MemoryVariant} />;
}
