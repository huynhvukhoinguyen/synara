// FILE: ProviderHealthBanner.tsx
// Purpose: Surfaces provider availability warnings above the active chat. A signed-out
//          provider gets a Sign in action that runs the CLI's login inside Synara.
// Layer: Chat status presentation
// Exports: ProviderHealthBanner

import { t } from "~/i18n";

import { localizeProviderStatusMessage } from "~/lib/providerStatusMessages";
import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@synara/contracts";
import { useState } from "react";
import { providerAccountNeedsSignIn } from "~/lib/providerSetupStatus";
import { ProviderGuidedSignIn } from "../settings/accounts/ProviderGuidedSignIn";
import type { ProviderSignInAccount } from "../settings/accounts/providerAccountShared";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import {
  EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
  NOTIFICATION_ICON_CLASS_NAME,
} from "../ui/notificationSurface";
import { CircleAlertIcon, TriangleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";
import { isProviderKind } from "../../providerOrdering";
import {
  ProviderRuntimeInstallButton,
  providerRuntimeInstallFailureMessage,
  providerRuntimeInstallOf,
} from "../ProviderRuntimeInstall";

export const ProviderHealthBanner = function ProviderHealthBanner({
  needsProviderSetup = false,
  onConfigure,
  onDismiss,
  status,
}: {
  needsProviderSetup?: boolean;
  onConfigure?: () => void;
  onDismiss?: () => void;
  status: ServerProviderStatus | null;
}) {
  const [signInAccount, setSignInAccount] = useState<ProviderSignInAccount | null>(null);
  const signInDialog = signInAccount ? (
    <ProviderGuidedSignIn
      key={String(signInAccount.instanceId)}
      account={signInAccount}
      onClosed={() => setSignInAccount(null)}
    />
  ) : null;

  // The dialog is a stable sibling of the banner: signing in flips the status to ready
  // mid-flow, and the banner leaving must not remount the sign-in session.
  if (!needsProviderSetup && (!status || status.status === "ready")) {
    return <>{signInDialog}</>;
  }

  const providerLabelFallback =
    status && isProviderKind(status.provider)
      ? PROVIDER_DISPLAY_NAMES[status.provider]
      : status?.provider;
  const providerLabel = status?.displayName?.trim() || providerLabelFallback || status?.provider;
  const defaultMessage = needsProviderSetup
    ? t("lattice:installOrSignInToAtLeast")
    : status?.status === "error"
      ? t("chat:providerIsUnavailable", { value0: providerLabel })
      : t("chat:providerHasLimitedAvailability", { value0: providerLabel });
  // A provider runtime the host left out installs right from the banner.
  const runtimeInstall = needsProviderSetup ? null : providerRuntimeInstallOf(status);
  const driver = status ? (status.driver ?? status.provider) : null;
  // A signed-out account gets a Sign in action that runs the CLI's login in place.
  const signInProvider =
    !needsProviderSetup &&
    !runtimeInstall &&
    status &&
    driver &&
    isProviderKind(driver) &&
    providerAccountNeedsSignIn({ status, enabled: status.enabled !== false })
      ? driver
      : null;
  const hasAction = Boolean(onConfigure || runtimeInstall);
  const message = needsProviderSetup
    ? defaultMessage
    : runtimeInstall?.status === "failed"
      ? providerRuntimeInstallFailureMessage(t, runtimeInstall)
      : signInProvider
        ? t("lattice:providerHealthBanner_signInBody", { provider: providerLabel })
        : status?.message
          ? localizeProviderStatusMessage(t, status.message)
          : defaultMessage;
  const title = needsProviderSetup
    ? t("lattice:setUpAnAgentProvider")
    : signInProvider
      ? t("settings:signInTo2", { value0: providerLabel })
      : t("chat:providerStatus", { value0: providerLabel });
  const isError = status?.status === "error";
  const Icon = isError ? CircleAlertIcon : TriangleAlertIcon;

  return (
    <>
      {signInDialog}
      <ChatColumnBannerFrame>
        <Alert
          className={cn(
            "provider-health-banner",
            EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
            !hasAction && onDismiss && "pr-10",
          )}
          variant={needsProviderSetup ? "info" : isError ? "error" : "warning"}
        >
          <Icon className={NOTIFICATION_ICON_CLASS_NAME} />
          <AlertTitle className="font-normal text-[var(--notification-fg)]">{title}</AlertTitle>
          <AlertDescription
            className="line-clamp-3 text-[var(--notification-fg)]/72"
            title={message}
          >
            {message}
          </AlertDescription>
          {signInProvider && status ? (
            <div className="col-start-2 pt-1.5">
              <Button
                size="xs"
                disabled={signInAccount !== null}
                onClick={() =>
                  setSignInAccount({
                    provider: signInProvider,
                    instanceId: status.instanceId ?? signInProvider,
                    label: providerLabel ?? signInProvider,
                  })
                }
              >
                {t("chat:providerModelPicker_signIn")}
              </Button>
            </div>
          ) : null}
          {hasAction || onDismiss ? (
            <AlertAction className={cn("items-center", !hasAction && "absolute top-2 right-2")}>
              {runtimeInstall && status ? (
                <ProviderRuntimeInstallButton status={status} />
              ) : onConfigure ? (
                <Button size="xs" variant="outline" onClick={onConfigure}>
                  {t("lattice:providerSettings")}
                </Button>
              ) : null}
              {onDismiss ? (
                <IconButton
                  className="size-6 rounded-full text-[var(--notification-fg)]/65 hover:bg-[var(--notification-fg)]/10 hover:text-[var(--notification-fg)] focus-visible:ring-[var(--notification-fg)]/35 sm:size-6"
                  label={t("chat:providerHealthBanner_dismissLabel")}
                  title={t("chat:providerHealthBanner_dismissLabel")}
                  onClick={onDismiss}
                >
                  <XIcon className="size-3.5" />
                </IconButton>
              ) : null}
            </AlertAction>
          ) : null}
        </Alert>
      </ChatColumnBannerFrame>
    </>
  );
};
