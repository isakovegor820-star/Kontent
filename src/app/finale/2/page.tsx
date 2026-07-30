import { VariantLanding } from "@/components/v3/variants/landing";

export default function FinaleVariantTwoPage() {
  return (
    <VariantLanding
      variant={4}
      showSwitcher={false}
      reasonsVariant={2}
      footerVariant={3}
      footerInteractionVariant={3}
      enableScrollMotion
      finaleVariant={2}
      showFinaleSwitcher
    />
  );
}
