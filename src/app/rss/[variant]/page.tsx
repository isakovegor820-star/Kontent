import { notFound } from "next/navigation";
import {
  RssVariants,
  type RssVariant,
} from "@/components/rss-design/rss-variants";

const VARIANTS = new Set(["1", "2", "3", "4"]);

export function generateStaticParams() {
  return [...VARIANTS].map((variant) => ({ variant }));
}

export default async function RssDesignVariantPage({
  params,
}: {
  params: Promise<{ variant: string }>;
}) {
  const { variant } = await params;
  if (!VARIANTS.has(variant)) notFound();

  return <RssVariants variant={Number(variant) as RssVariant} />;
}
