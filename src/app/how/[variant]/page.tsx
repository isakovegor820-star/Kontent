import { notFound } from "next/navigation";
import {
  HowVariants,
  type HowVariant,
} from "@/components/v3/how-variants/how-variants";

const VARIANTS = new Set(["1", "2", "3", "4"]);

export function generateStaticParams() {
  return [...VARIANTS].map((variant) => ({ variant }));
}

export default async function HowVariantPage({
  params,
}: {
  params: Promise<{ variant: string }>;
}) {
  const { variant } = await params;
  if (!VARIANTS.has(variant)) notFound();

  return <HowVariants variant={Number(variant) as HowVariant} />;
}
