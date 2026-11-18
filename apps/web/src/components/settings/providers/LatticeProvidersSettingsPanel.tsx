// FILE: LatticeProvidersSettingsPanel.tsx
// Purpose: Lattice's embedded Agent page (Settings → Agent). Lattice frames no Accounts page
//          and offers no agent enable switches, so this keeps the page Lattice has always
//          shown: the provider picker, performance (with Load my MCP servers), updates, and
//          Provider runtimes, where each agent's row holds its install, CLI options and
//          accounts. Built from upstream's providers/ and accounts/ pieces.
// Layer: Settings panel (Lattice embed only)
// Exports: LatticeProvidersSettingsPanel

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerProviderUsageSnapshot,
  type ServerSettings,
} from "@synara/contracts";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getProviderInstanceOptions, type AppSettings } from "~/appSettings";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useTranslation } from "~/i18n";
import { CentralIcon } from "~/lib/central-icons";
import { ChevronLeftIcon } from "~/lib/icons";
import { findUsableProviderStatus, providerStatusInstanceKey } from "~/lib/providerAvailability";
import {
  hasReconciledServerProviderStatuses,
  serverAllProviderUsageQueryOptions,
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { isProviderKind, sameProviderOrder } from "~/providerOrdering";
import {
  getVisibleProviderUpdateStatuses,
  isProviderLatestVersionKnowable,
  isProviderUpdateActive,
  shouldOfferProviderUpdateAction,
  shouldPromptProviderUpdate,
  shouldShowProviderUpdateStatus,
  withProviderUpdateTimeout,
} from "~/providerUpdates";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
import {
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_INSET_RADIUS_CLASS_NAME,
  SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
  SETTINGS_PANEL_SECTION_GAP_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";
import { ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME } from "~/surfaceStyles";

import { ProviderIcon } from "../../ProviderIcon";
import {
  ProviderRuntimeInstallButton,
  ProviderRuntimeInstallPanel,
  providerRuntimeInstallLabel,
  providerRuntimeInstallOf,
} from "../../ProviderRuntimeInstall";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { ProviderAccountEditor } from "../accounts/ProviderAccountEditor";
import { ProviderAccountsList } from "../accounts/ProviderAccountsList";
import { SettingResetButton, useSettingsRestoreSignal } from "../SettingControls";
import { SettingsListRow, SettingsRow, SettingsSection } from "../SettingsPanelPrimitives";
import { UsageLimitRecoverySetting } from "../UsageLimitRecoverySetting";
import { ProviderDocsLinks } from "./ProviderDocsLinks";
import { ProviderInstallFieldControl } from "./ProviderInstallFieldControl";
import {
  createClosedProviderInstallDisclosureState,
  createProviderInstallDisclosureState,
  createProviderInstallResetPatch,
  isDefaultAccountIdentityField,
  isProviderInstallSettingsDirty,
  PROVIDER_VISIBILITY_OPTIONS,
  VISIBLE_PROVIDER_INSTALL_SETTINGS,
  type ProviderInstallSettings,
  type ProviderVisibilityOption,
} from "./providerInstallSettings";
import type { ProvidersSettingsPanelProps } from "./ProvidersSettingsPanel";
import { ProviderUpdateAction } from "./ProviderUpdateAction";
import {
  formatProviderVersion,
  providerStatusDisplayName,
  providerUpdateFailureMessage,
  providerUpdateStatusLabel,
} from "./providerUpdateLabels";

const NO_PROVIDER_TARGETS: ReadonlyArray<ProviderKind> = [];

function setProviderListMembership(
  current: ReadonlyArray<ProviderKind>,
  provider: ProviderKind,
  included: boolean,
): ProviderKind[] {
  const withoutTarget = current.filter((entry) => entry !== provider);
  return included ? [...withoutTarget, provider] : withoutTarget;
}

function SortableProviderVisibilityRow(props: {
  option: ProviderVisibilityOption;
  providerStatus: ServerProviderStatus | undefined;
  isHidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}) {
  const { t } = useTranslation();

  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.option.provider });
  const isChecking = props.providerStatus === undefined;
  const isAvailable = props.providerStatus?.available === true;
  const runtimeInstall = providerRuntimeInstallOf(props.providerStatus);
  const isEnabled = isAvailable && !props.isHidden;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
        "flex items-center justify-between gap-3 px-3 py-2.5",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={cn(
            "inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing",
            ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME,
            SETTINGS_INSET_RADIUS_CLASS_NAME,
          )}
          aria-label={t("workspace:reorder", { value0: props.option.title })}
          {...attributes}
          {...listeners}
        >
          <CentralIcon name="dot-grid-2x3" className="size-4" />
        </button>
        <ProviderIcon provider={props.option.provider} className="size-4 shrink-0" />
        <span className="min-w-0">
          <span className="block truncate text-ui text-foreground">{props.option.title}</span>
          <span className="block text-ui-sm text-muted-foreground">
            {isChecking
              ? t("chat:providerModelPicker_checking_command")
              : isAvailable
                ? t("settings:installed")
                : runtimeInstall
                  ? providerRuntimeInstallLabel(t, runtimeInstall)
                  : t("lattice:cLINotInstalled")}
          </span>
        </span>
      </div>
      {/* Installing it here is what makes the provider pickable at all. */}
      {runtimeInstall && props.providerStatus ? (
        <ProviderRuntimeInstallButton status={props.providerStatus} className="ml-auto" />
      ) : null}
      <Switch
        checked={isEnabled}
        disabled={isChecking || !isAvailable}
        onCheckedChange={(checked) => props.onHiddenChange(!checked)}
        aria-label={
          isChecking
            ? t("settings:checkingCLIAvailability", { value0: props.option.title })
            : isAvailable
              ? t("settings:showInTheProviderPicker", { value0: props.option.title })
              : t("settings:isUnavailableInTheProviderPicker", { value0: props.option.title })
        }
      />
    </div>
  );
}

/**
 * One agent's accounts inside its Provider runtimes row: the list, and an account's
 * editor in place of the list once it is opened.
 */
function ProviderRowAccounts(props: {
  config: ProviderInstallSettings;
  providerStatusByInstance: ReadonlyMap<string, ServerProviderStatus>;
  usageByInstance: ReadonlyMap<string, ServerProviderUsageSnapshot>;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);

  if (openAccountId !== null) {
    return (
      <div className="space-y-3">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="-ml-2"
          onClick={() => setOpenAccountId(null)}
        >
          <ChevronLeftIcon className="size-3.5" />
          {t("settings:accounts_back")}
        </Button>
        <ProviderAccountEditor
          accountId={openAccountId}
          config={props.config}
          providerStatusByInstance={props.providerStatusByInstance}
          usageByInstance={props.usageByInstance}
          settings={props.settings}
          updateSettings={props.updateSettings}
          updateSettingsAndWait={props.updateSettingsAndWait}
          onAccountRemoved={() => setOpenAccountId(null)}
        />
      </div>
    );
  }

  return (
    <ProviderAccountsList
      provider={props.config.provider}
      providerStatusByInstance={props.providerStatusByInstance}
      usageByInstance={props.usageByInstance}
      settings={props.settings}
      updateSettings={props.updateSettings}
      updateSettingsAndWait={props.updateSettingsAndWait}
      onOpenAccount={setOpenAccountId}
    />
  );
}

function ProviderToolRow(props: {
  config: ProviderInstallSettings;
  open: boolean;
  settings: AppSettings;
  hiddenProviderSet: ReadonlySet<ProviderKind>;
  serverSettings: Pick<
    ServerSettings,
    "providers" | "providerInstances" | "enableProviderUpdateChecks"
  > | null;
  providerStatus: ServerProviderStatus | undefined;
  providerStatusByInstance: ReadonlyMap<string, ServerProviderStatus>;
  usageByInstance: ReadonlyMap<string, ServerProviderUsageSnapshot>;
  isDirty: boolean;
  updatingProviders: ReadonlySet<ProviderInstanceId>;
  onOpenChange: (open: boolean) => void;
  onUpdate: (provider: ProviderKind, instanceId?: ProviderInstanceId) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();

  const title = PROVIDER_DISPLAY_NAMES[props.config.provider];
  // A slim host installs Pi and OpenCode on demand; until then the row offers it.
  const runtimeInstall = providerRuntimeInstallOf(props.providerStatus);
  const showProviderUpdateStatus = props.providerStatus
    ? shouldShowProviderUpdateStatus({
        provider: props.providerStatus,
        hiddenProviderSet: props.hiddenProviderSet,
        serverSettings: props.serverSettings,
      })
    : false;
  const updateAdvisory = props.providerStatus?.versionAdvisory;
  const providerUpdateSuppressed =
    updateAdvisory?.status === "behind_latest" && !showProviderUpdateStatus;
  const currentProviderVersion = formatProviderVersion(props.providerStatus?.version);
  const providerUpdateLabel = runtimeInstall
    ? providerRuntimeInstallLabel(t, runtimeInstall)
    : props.providerStatus
      ? !props.settings.enableProviderUpdateChecks
        ? currentProviderVersion
          ? t("settings:current", { value0: currentProviderVersion })
          : null
        : providerUpdateSuppressed
          ? null
          : providerUpdateStatusLabel(props.providerStatus)
      : null;
  const updateActive = Boolean(
    (props.providerStatus && isProviderUpdateActive(props.providerStatus)) ||
    props.updatingProviders.has(
      props.providerStatus
        ? providerStatusInstanceKey(props.providerStatus)
        : props.config.provider,
    ),
  );
  const showUpdateButton = props.providerStatus
    ? shouldPromptProviderUpdate(props.providerStatus) &&
      (showProviderUpdateStatus || updateAdvisory?.status === "unknown")
    : false;
  // Self-updating CLIs never report a latest version, so the update stays available
  // inside the panel rather than as a header badge that can never be satisfied.
  const showSelfManagedUpdate = props.providerStatus
    ? shouldOfferProviderUpdateAction(props.providerStatus) &&
      !isProviderLatestVersionKnowable(props.providerStatus)
    : false;

  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
      <div className="border-t border-border/70 first:border-t-0">
        <div className="flex min-h-11 items-center gap-2 px-3 py-2">
          <CollapsibleTrigger
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="min-w-0 flex-1 text-ui-lg font-medium text-foreground">{title}</span>
            {props.isDirty ? (
              <span className="shrink-0 text-ui-sm text-muted-foreground">
                {t("settings:schedule_custom")}
              </span>
            ) : null}
            {providerUpdateLabel ? (
              <span
                className={cn(
                  "shrink-0 text-ui-sm",
                  updateAdvisory?.status === "behind_latest"
                    ? "text-foreground"
                    : runtimeInstall?.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground",
                  runtimeInstall?.status === "installing" && "tabular-nums",
                )}
              >
                {providerUpdateLabel}
              </span>
            ) : null}
            <DisclosureChevron
              open={props.open}
              className="size-4 shrink-0 text-muted-foreground"
            />
          </CollapsibleTrigger>
          {runtimeInstall && props.providerStatus ? (
            <ProviderRuntimeInstallButton status={props.providerStatus} />
          ) : null}
          {showUpdateButton && props.providerStatus ? (
            <ProviderUpdateAction
              providerStatus={props.providerStatus}
              active={updateActive}
              disabled={updateActive}
              onUpdate={props.onUpdate}
            />
          ) : null}
        </div>

        <CollapsiblePanel>
          <div className="border-t border-border/70 bg-muted/20 px-3 py-3">
            <div className="space-y-3">
              {runtimeInstall && props.providerStatus ? (
                <ProviderRuntimeInstallPanel
                  status={props.providerStatus}
                  align="start"
                  showAction={false}
                />
              ) : null}
              <ProviderDocsLinks docs={props.config.docs} />
              {showProviderUpdateStatus && updateAdvisory?.status === "behind_latest" ? (
                <div className="text-ui leading-snug text-muted-foreground">
                  {updateAdvisory.canUpdate && updateAdvisory.updateCommand ? (
                    <>
                      <span>{t("settings:command")} </span>
                      <code className="font-mono">{updateAdvisory.updateCommand}</code>
                    </>
                  ) : (
                    t("lattice:aNewerVersionIsAvailableButLattice")
                  )}
                </div>
              ) : null}
              {showSelfManagedUpdate && props.providerStatus ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-ui-xs text-muted-foreground">
                    {t("lattice:managesItsOwnReleasesSoLatticeCannot")}
                  </div>
                  <ProviderUpdateAction
                    providerStatus={props.providerStatus}
                    active={updateActive}
                    disabled={updateActive}
                    onUpdate={props.onUpdate}
                  />
                </div>
              ) : null}
              {props.config.fields
                .filter((field) => !isDefaultAccountIdentityField(field))
                .map((field) => (
                  <ProviderInstallFieldControl
                    key={field.settingsKey}
                    field={field}
                    settings={props.settings}
                    updateSettings={props.updateSettings}
                  />
                ))}
              <ProviderRowAccounts
                config={props.config}
                providerStatusByInstance={props.providerStatusByInstance}
                usageByInstance={props.usageByInstance}
                settings={props.settings}
                updateSettings={props.updateSettings}
                updateSettingsAndWait={props.updateSettingsAndWait}
              />
            </div>
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

export function LatticeProvidersSettingsPanel({
  settings,
  defaults,
  updateSettings,
  updateSettingsAndWait,
  active,
  providerTargets = NO_PROVIDER_TARGETS,
  resetEpoch,
}: ProvidersSettingsPanelProps) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const localProviderStatuses = useProviderStatusesForLocalConfig();
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  // One usage fetch for every agent's accounts; nothing is fetched while the page is closed.
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions({ enabled: active }));
  const usageByInstance = useMemo(
    () =>
      new Map<string, ServerProviderUsageSnapshot>(
        (usageQuery.data ?? []).map((snapshot) => [
          snapshot.instanceId ?? snapshot.provider,
          snapshot,
        ]),
      ),
    [usageQuery.data],
  );
  const [openInstallProviders, setOpenInstallProviders] = useState<Record<ProviderKind, boolean>>(
    () => ({
      ...createProviderInstallDisclosureState(settings, defaults),
      ...Object.fromEntries(providerTargets.map((provider) => [provider, true])),
    }),
  );
  const [updatingProviders, setUpdatingProviders] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(),
  );
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const hiddenProviderCount = hiddenProviderSet.size;
  const providerVisibilityOptionsByProvider = useMemo(
    () => new Map(PROVIDER_VISIBILITY_OPTIONS.map((option) => [option.provider, option])),
    [],
  );
  const orderedProviderVisibilityOptions = useMemo(
    () =>
      settings.providerOrder.flatMap((provider) => {
        const option = providerVisibilityOptionsByProvider.get(provider);
        return option ? [option] : [];
      }),
    [providerVisibilityOptionsByProvider, settings.providerOrder],
  );
  const providerVisibilitySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const providerStatusByProvider = useMemo(
    () =>
      new Map<ProviderKind, ServerProviderStatus>(
        localProviderStatuses.flatMap((status) => {
          const driver = status.driver ?? status.provider;
          return isProviderKind(driver) && providerStatusInstanceKey(status) === driver
            ? [[driver, status] as const]
            : [];
        }),
      ),
    [localProviderStatuses],
  );
  const providerStatusByInstance = useMemo(
    () =>
      new Map<string, ServerProviderStatus>(
        localProviderStatuses.map((status) => [providerStatusInstanceKey(status), status]),
      ),
    [localProviderStatuses],
  );
  const configuredInstances = getProviderInstanceOptions(settings);
  const providerSetupStatusByProvider = new Map(
    orderedProviderVisibilityOptions.map(
      ({ provider }) =>
        [
          provider,
          findUsableProviderStatus(
            localProviderStatuses,
            provider,
            provider,
            configuredInstances,
          ) ?? providerStatusByProvider.get(provider),
        ] as const,
    ),
  );
  const availableProviderCount = orderedProviderVisibilityOptions.filter(
    (option) => providerSetupStatusByProvider.get(option.provider)?.available === true,
  ).length;
  const visibleAvailableProviderCount = orderedProviderVisibilityOptions.filter(
    (option) =>
      providerSetupStatusByProvider.get(option.provider)?.available === true &&
      !hiddenProviderSet.has(option.provider),
  ).length;
  const hasPendingProviderStatuses =
    !providerStatusesReconciled ||
    orderedProviderVisibilityOptions.some(
      (option) => !providerSetupStatusByProvider.get(option.provider),
    );
  const providerUpdateServerSettings = useMemo(
    () =>
      serverSettingsQuery.data
        ? {
            ...serverSettingsQuery.data,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }
        : null,
    [serverSettingsQuery.data, settings.enableProviderUpdateChecks],
  );
  const outdatedProviderStatuses = useMemo(
    () =>
      getVisibleProviderUpdateStatuses({
        providers: serverConfigQuery.data?.providers ?? [],
        hiddenProviders: settings.hiddenProviders,
        serverSettings: providerUpdateServerSettings,
      }),
    [providerUpdateServerSettings, serverConfigQuery.data?.providers, settings.hiddenProviders],
  );
  const outdatedProviderCount = outdatedProviderStatuses.length;
  const installSettingsDirty = isProviderInstallSettingsDirty(settings, defaults);
  const dirtyInstallDisclosure = createProviderInstallDisclosureState(settings, defaults);

  useSettingsRestoreSignal(resetEpoch, () => {
    setOpenInstallProviders(createClosedProviderInstallDisclosureState());
  });

  const providerTargetsKey = providerTargets.join(",");
  useEffect(() => {
    if (!active || !providerTargetsKey) return;
    const opened = Object.fromEntries(providerTargetsKey.split(",").map((key) => [key, true]));
    setOpenInstallProviders((current) => ({ ...current, ...opened }));
  }, [active, providerTargetsKey]);

  const handleProviderOrderDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = settings.providerOrder.indexOf(active.id as ProviderKind);
      const toIndex = settings.providerOrder.indexOf(over.id as ProviderKind);
      if (fromIndex < 0 || toIndex < 0) return;
      updateSettings({ providerOrder: arrayMove([...settings.providerOrder], fromIndex, toIndex) });
    },
    [settings.providerOrder, updateSettings],
  );

  const runProviderUpdate = useCallback(
    async (provider: ProviderKind, instanceId?: ProviderInstanceId) => {
      const targetId = instanceId ?? provider;
      if (updatingProviders.has(targetId)) return;
      setUpdatingProviders((current) => new Set(current).add(targetId));
      await withProviderUpdateTimeout({
        provider,
        request: ensureNativeApi().server.updateProvider({
          provider,
          ...(instanceId ? { instanceId } : {}),
        }),
      })
        .then((result) => {
          const refreshedProvider = result.providers.find(
            (status) =>
              (status.driver ?? status.provider) === provider &&
              providerStatusInstanceKey(status) === targetId,
          );
          const failureMessage = providerUpdateFailureMessage(refreshedProvider);
          if (failureMessage) {
            const manualCommand = refreshedProvider?.versionAdvisory?.updateCommand?.trim();
            toastManager.add({
              type: "error",
              title: t("settings:couldNotUpdate", {
                value0: refreshedProvider
                  ? providerStatusDisplayName(refreshedProvider)
                  : PROVIDER_DISPLAY_NAMES[provider],
              }),
              description: manualCommand
                ? t("settings:copyTheCommandBelowToUpdateManuallyInA", {
                    value0: failureMessage,
                  })
                : failureMessage,
              ...(manualCommand ? { data: { copyText: manualCommand } } : {}),
            });
            return;
          }
          toastManager.add({
            type: "success",
            title: t("settings:updateFinished", {
              value0: refreshedProvider
                ? providerStatusDisplayName(refreshedProvider)
                : PROVIDER_DISPLAY_NAMES[provider],
            }),
            description: t("settings:newSessionsWillUseTheRefreshedProvider"),
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: t("settings:couldNotUpdate", { value0: PROVIDER_DISPLAY_NAMES[provider] }),
            description:
              error instanceof Error ? error.message : t("settings:theProviderUpdateFailed"),
          });
        })
        .finally(async () => {
          await queryClient
            .invalidateQueries({ queryKey: serverQueryKeys.config() })
            .catch(() => undefined);
          setUpdatingProviders((current) => {
            const next = new Set(current);
            next.delete(targetId);
            return next;
          });
        });
    },
    [queryClient, updatingProviders, t],
  );

  if (!active) return null;

  return (
    // Embedded Lattice stacks this panel under ModelsSettingsPanel on one page.
    <div className={cn("space-y-6", SETTINGS_PANEL_SECTION_GAP_CLASS_NAME)}>
      <SettingsSection title={t("settings:providers_providerPicker")}>
        <SettingsRow
          title={t("settings:availableCLIs")}
          description={t("settings:showOrHideInstalledProvidersInThePickerAnd2")}
          status={
            serverConfigQuery.isPending || hasPendingProviderStatuses
              ? t("lattice:checkingInstalledCLIs")
              : availableProviderCount === 0
                ? t("lattice:noCLIsDetected")
                : visibleAvailableProviderCount < availableProviderCount
                  ? t("lattice:ofInstalledShown", {
                      visibleAvailableProviderCount,
                      availableProviderCount,
                    })
                  : isProviderOrderDirty
                    ? t("lattice:installedCustomOrder", { availableProviderCount })
                    : t("lattice:installed", { availableProviderCount })
          }
          resetAction={
            hiddenProviderCount > 0 || isProviderOrderDirty ? (
              <SettingResetButton
                label={t("settings:providerPicker")}
                onClick={() =>
                  updateSettings({
                    hiddenProviders: defaults.hiddenProviders,
                    providerOrder: defaults.providerOrder,
                  })
                }
              />
            ) : null
          }
        >
          <DndContext
            sensors={providerVisibilitySensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleProviderOrderDragEnd}
          >
            <SortableContext
              items={orderedProviderVisibilityOptions.map((option) => option.provider)}
              strategy={verticalListSortingStrategy}
            >
              <div className="mt-4 space-y-2">
                {orderedProviderVisibilityOptions.map((option) => (
                  <SortableProviderVisibilityRow
                    key={option.provider}
                    option={option}
                    providerStatus={providerSetupStatusByProvider.get(option.provider)}
                    isHidden={hiddenProviderSet.has(option.provider)}
                    onHiddenChange={(hidden) =>
                      updateSettings({
                        hiddenProviders: setProviderListMembership(
                          settings.hiddenProviders,
                          option.provider,
                          hidden,
                        ),
                      })
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </SettingsRow>
      </SettingsSection>

      <div className={SETTINGS_PANEL_SECTION_GAP_CLASS_NAME}>
        <SettingsSection title={t("settings:performance")}>
          <UsageLimitRecoverySetting />
          <SettingsRow
            id="setting-keep-synara-responsive"
            title={t("settings:keepSynaraResponsive")}
            description={t("settings:giveAgentProcessesAndTheirCommandsAModeratelyLower")}
            status={t("lattice:appliesToNewlyLaunchedAgentProcessesRestart")}
            resetAction={
              settings.lowerProviderProcessPriority !== defaults.lowerProviderProcessPriority ? (
                <SettingResetButton
                  label={t("settings:keepSynaraResponsive")}
                  onClick={() =>
                    updateSettings({
                      lowerProviderProcessPriority: defaults.lowerProviderProcessPriority,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.lowerProviderProcessPriority}
                onCheckedChange={(checked) =>
                  updateSettings({ lowerProviderProcessPriority: Boolean(checked) })
                }
                aria-label={t("settings:keepSynaraResponsive")}
              />
            }
          />
          <SettingsRow
            id="setting-claude-user-mcp-servers"
            title={t("lattice:loadMyMCPServersInClaude")}
            description={t("lattice:offNewChatsStartFasterAndUse")}
            status={t("lattice:appliesToNewAndRestartedChatsA")}
            resetAction={
              settings.claudeLoadUserMcpServers !== defaults.claudeLoadUserMcpServers ? (
                <SettingResetButton
                  label={t("lattice:loadMyMCPServersInClaude")}
                  onClick={() =>
                    updateSettings({
                      claudeLoadUserMcpServers: defaults.claudeLoadUserMcpServers,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.claudeLoadUserMcpServers}
                onCheckedChange={(checked) =>
                  updateSettings({ claudeLoadUserMcpServers: Boolean(checked) })
                }
                aria-label={t("lattice:loadMyMCPServersInClaude")}
              />
            }
          />
        </SettingsSection>
      </div>

      <div id={SETTINGS_TARGETS.providerUpdates} className={SETTINGS_PANEL_SECTION_GAP_CLASS_NAME}>
        <SettingsSection title={t("settings:providerUpdates_updates")}>
          <SettingsRow
            id="setting-automatic-cli-update-checks"
            title="settings:providerUpdates_automaticCliUpdateChecks"
            description="settings:checkCodexClaudeAndOtherProviderCLIsForNewer"
            resetAction={
              settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks ? (
                <SettingResetButton
                  label={t("settings:cLIUpdateChecks")}
                  onClick={() =>
                    updateSettings({
                      enableProviderUpdateChecks: defaults.enableProviderUpdateChecks,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.enableProviderUpdateChecks}
                onCheckedChange={(checked) =>
                  updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
                }
                aria-label={t("settings:providerUpdates_automaticCliUpdateChecks")}
              />
            }
          />

          <SettingsRow
            id="setting-provider-updates"
            title={t("settings:providerUpdates_providerUpdates")}
            description={t("lattice:reviewInstalledProviderToolsThatLatticeCan")}
            status={
              !settings.enableProviderUpdateChecks
                ? t("lattice:automaticChecksOff")
                : outdatedProviderCount > 0
                  ? t("lattice:updatesAvailable", {
                      outdatedProviderCount,
                      count: outdatedProviderCount,
                    })
                  : t("lattice:noProviderUpdatesDetected")
            }
          >
            {settings.enableProviderUpdateChecks && outdatedProviderStatuses.length > 0 ? (
              <div
                className={cn(
                  "mt-4",
                  SETTINGS_INSET_LIST_CLASS_NAME,
                  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
                )}
              >
                {outdatedProviderStatuses.map((providerStatus) => {
                  const instanceId = providerStatusInstanceKey(providerStatus);
                  const updateActive =
                    isProviderUpdateActive(providerStatus) || updatingProviders.has(instanceId);
                  const updateLabel = providerUpdateStatusLabel(providerStatus);
                  return (
                    // Inside the outlined list, inset the row from the border and
                    // separate rows the way the Provider tools list below does;
                    // the page-level row has no inline padding of its own.
                    <SettingsListRow
                      key={instanceId}
                      className="border-t border-border/70 px-3 first:border-t-0"
                      title={providerStatusDisplayName(providerStatus)}
                      description={updateLabel || undefined}
                      actions={
                        providerStatus.versionAdvisory?.canUpdate ? (
                          <ProviderUpdateAction
                            providerStatus={providerStatus}
                            active={updateActive}
                            disabled={updateActive}
                            onUpdate={(provider) => void runProviderUpdate(provider)}
                          />
                        ) : (
                          <span className="text-ui-sm text-muted-foreground">
                            {t("settings:providerUpdates_manualUpdate")}
                          </span>
                        )
                      }
                    />
                  );
                })}
              </div>
            ) : null}
          </SettingsRow>
        </SettingsSection>
      </div>

      <div id={SETTINGS_TARGETS.providerInstalls} className={SETTINGS_PANEL_SECTION_GAP_CLASS_NAME}>
        <SettingsSection title={t("settings:providers_providerTools")}>
          <SettingsRow
            id="setting-installed-clis"
            title={t("lattice:providerRuntimes")}
            description={t("lattice:reviewExternalProviderCLIsPiAndOpenCode")}
            status={
              !settings.enableProviderUpdateChecks
                ? t("lattice:automaticChecksOff")
                : outdatedProviderCount > 0
                  ? t("lattice:updatesAvailable", {
                      outdatedProviderCount,
                      count: outdatedProviderCount,
                    })
                  : t("lattice:noProviderUpdatesDetected")
            }
            resetAction={
              installSettingsDirty ? (
                <SettingResetButton
                  label={t("settings:providerTools")}
                  onClick={() => {
                    updateSettings(createProviderInstallResetPatch(defaults));
                    setOpenInstallProviders(createClosedProviderInstallDisclosureState());
                  }}
                />
              ) : null
            }
          >
            <div className="mt-4">
              <div className={SETTINGS_INSET_LIST_CLASS_NAME}>
                {VISIBLE_PROVIDER_INSTALL_SETTINGS.map((config) => (
                  <ProviderToolRow
                    key={config.provider}
                    config={config}
                    open={openInstallProviders[config.provider] ?? false}
                    settings={settings}
                    hiddenProviderSet={hiddenProviderSet}
                    serverSettings={providerUpdateServerSettings}
                    providerStatus={providerStatusByProvider.get(config.provider)}
                    providerStatusByInstance={providerStatusByInstance}
                    usageByInstance={usageByInstance}
                    isDirty={dirtyInstallDisclosure[config.provider] ?? false}
                    updatingProviders={updatingProviders}
                    onOpenChange={(open) =>
                      setOpenInstallProviders((existing) => ({
                        ...existing,
                        [config.provider]: open,
                      }))
                    }
                    onUpdate={(provider) => void runProviderUpdate(provider)}
                    updateSettings={updateSettings}
                    updateSettingsAndWait={updateSettingsAndWait}
                  />
                ))}
              </div>
            </div>
          </SettingsRow>
        </SettingsSection>
      </div>
    </div>
  );
}
