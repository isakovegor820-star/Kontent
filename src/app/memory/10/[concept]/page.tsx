import { notFound } from "next/navigation";
import {
  MemoryManifestVariants,
  type ManifestVariant,
} from "@/components/v3/memory-manifest-variants/memory-manifest-variants";

const CONCEPTS = new Set(["1", "2", "3", "4", "5"]);

export function generateStaticParams() {
  return [...CONCEPTS].map((concept) => ({ concept }));
}

export default async function MemoryManifestConceptPage({
  params,
}: {
  params: Promise<{ concept: string }>;
}) {
  const { concept } = await params;
  if (!CONCEPTS.has(concept)) notFound();

  return <MemoryManifestVariants variant={Number(concept) as ManifestVariant} />;
}
