import { notFound } from "next/navigation";
import { QualityVariants, type QualityVariant } from "@/components/v3/quality-variants/quality-variants";

const VARIANTS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

export function generateStaticParams() {
  return [...VARIANTS].map((variant) => ({ variant }));
}

export default async function QualityVariantPage({ params }: { params: Promise<{ variant: string }> }) {
  const { variant } = await params;
  if (!VARIANTS.has(variant)) notFound();
  return <QualityVariants variant={Number(variant) as QualityVariant} />;
}
