"use client";

import { RouteErrorBoundary } from "@/components/app/route-error";

export default function SegmentError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return <RouteErrorBoundary error={error} unstable_retry={unstable_retry} title="composer" />;
}
