// FILE: UsageSettingsPanel.tsx
// Purpose: The Usage pane — Overview (provider limits and display options), Analytics
//          (cost and tokens over time), and Billing (the Synara Alto plan) when billing
//          is enabled.
// Layer: Settings UI components
// Exports: UsageSettingsPanel

import { type ReactNode, useState } from "react";

import { useTranslation } from "~/i18n";

import { SegmentedPicker } from "../SegmentedPicker";
import { BillingSettingsPanel, SYNARA_PLAN_SECTION_ID } from "./BillingSettingsPanel";
import { ProviderUsageSettingsPanel } from "./ProviderUsageSettingsPanel";
import { UsageAnalyticsPanel } from "./UsageAnalyticsPanel";

type UsageTab = "overview" | "analytics" | "billing";

/**
 * Deep links to the plan (`target=settings-synara-plan`) open on Billing. The route
 * keys this panel by its target, so a new link resets the tab.
 */
export function UsageSettingsPanel({
  billingEnabled,
  target,
  overviewExtra,
}: {
  billingEnabled: boolean;
  target: string | null;
  /** Settings that react to limits (warnings, auto-resume), shown under Overview. */
  overviewExtra?: ReactNode;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<UsageTab>(() =>
    billingEnabled && target === SYNARA_PLAN_SECTION_ID ? "billing" : "overview",
  );
  return (
    <div className="space-y-6">
      <SegmentedPicker<UsageTab>
        ariaLabel={t("lattice:usageTabsLabel")}
        variant="buttons"
        value={tab}
        onValueChange={setTab}
        options={[
          { value: "overview", label: t("lattice:usageTabOverview") },
          { value: "analytics", label: t("lattice:usageTabAnalytics") },
          ...(billingEnabled
            ? [{ value: "billing" as const, label: t("lattice:usageTabBilling") }]
            : []),
        ]}
      />
      <div>
        {tab === "analytics" ? (
          <UsageAnalyticsPanel />
        ) : tab === "billing" && billingEnabled ? (
          <BillingSettingsPanel />
        ) : (
          <div className="space-y-6">
            <ProviderUsageSettingsPanel />
            {overviewExtra}
          </div>
        )}
      </div>
    </div>
  );
}
