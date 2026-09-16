"use client";

import OpportunitiesPage from "../opportunities/page";

/**
 * Infopovody and the broader opportunity map share one channel-scoped signal engine.
 * This surface intentionally keeps only timely public market signals; competitor,
 * audience and offer gaps remain available in the strategic opportunity map.
 */
export default function InfopovodyPage() {
  return <OpportunitiesPage />;
}
