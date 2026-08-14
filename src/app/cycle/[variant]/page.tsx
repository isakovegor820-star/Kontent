import { notFound } from "next/navigation";
import {
  CycleVariants,
  type CycleVariant,
} from "@/components/landing/cycle-variants/cycle-variants";

const VARIANTS = new Set(["1", "2", "3", "4", "5"]);

export function generateStaticParams() {
  return [...VARIANTS].map((variant) => ({ variant }));
}

export default async function CycleVariantPage({
  params,
}: {
  params: Promise<{ variant: string }>;
}) {
  const { variant } = await params;
  if (!VARIANTS.has(variant)) notFound();

  return <CycleVariants variant={Number(variant) as CycleVariant} />;
}
