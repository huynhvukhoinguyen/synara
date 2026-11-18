// FILE: LatticeProvidersSettingsPanel.browser.tsx
// Purpose: Lattice's embedded Agent page: picker rows, performance, and provider updates.
// Layer: Component browser tests

import "../../../index.css";

import {
  type ServerProviderStatus,
  type ServerProviderUsageSnapshot,
  type TerminalEvent,
  type TerminalOpenInput,
} from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { page, userEvent } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render as renderInBrowser } from "vitest-browser-react";
import { type ReactNode } from "react";

const harness = vi.hoisted(() => ({
  statuses: [] as ServerProviderStatus[],
  usage: [] as ServerProviderUsageSnapshot[],
  reconciled: true,
  refresh: vi.fn(),
  invalidate: vi.fn(async () => {}),
  terminalListener: null as ((event: TerminalEvent) => void) | null,
  api: {
    terminal: {
      open: vi.fn(),
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      ackOutput: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onEvent: vi.fn(),
    },
    shell: { openExternal: vi.fn(async () => {}) },
  },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const queryClient = { invalidateQueries: harness.invalidate };
  return {
    ...(await importOriginal<typeof import("@tanstack/react-query")>()),
    useQueryClient: () => queryClient,
    // One payload answers both the server config and the server settings query;
    // `providerInstances` lets the settings read find no per-instance overrides.
    useQuery: (options: { queryKey?: readonly string[] }) => ({
      data:
        options.queryKey?.[1] === "allProviderUsage"
          ? harness.usage
          : { providers: harness.statuses, providerInstances: {}, cwd: "/tmp" },
      isPending: false,
    }),
  };
});
vi.mock("~/lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/serverReactQuery")>()),
  serverConfigQueryOptions: () => ({}),
  serverSettingsQueryOptions: () => ({}),
  hasReconciledServerProviderStatuses: () => harness.reconciled,
  serverQueryKeys: {
    config: () => ["config"],
    settings: () => ["settings"],
    allProviderUsage: () => ["server", "allProviderUsage"],
  },
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => harness.statuses,
}));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => harness.refresh,
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
  readNativeApiServerCapability: () => false,
  onNativeApiServerCapabilitiesChange: () => () => undefined,
}));

import { AppSettingsSchema } from "~/appSettings";
import { t, setLanguagePreference } from "~/i18n";
import { LatticeProvidersSettingsPanel as ProvidersSettingsPanel } from "./LatticeProvidersSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});
const props = {
  defaults,
  settings: defaults,
  updateSettings: vi.fn(),
  updateSettingsAndWait: vi.fn(async () => {}),
  active: true,
  resetEpoch: 0,
  onManageAccounts: vi.fn(),
};

// The panel reads its copy through Lingui, so every render needs the provider.
function render(ui: ReactNode) {
  return renderInBrowser(<>{ui}</>);
}

beforeEach(() => {
  setLanguagePreference("en");
  harness.usage = [];
  harness.reconciled = true;
  harness.refresh.mockReset();
  harness.api.terminal.open.mockReset().mockImplementation(async (input: TerminalOpenInput) => ({
    ...input,
    status: "running",
    history: "",
    pid: 1234,
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-02T12:00:00Z",
  }));
  harness.api.terminal.write.mockClear();
  harness.api.terminal.close.mockReset().mockResolvedValue(undefined);
  harness.api.terminal.onEvent.mockImplementation((listener: (event: TerminalEvent) => void) => {
    harness.terminalListener = listener;
    return () => {
      harness.terminalListener = null;
    };
  });
  harness.statuses = PROVIDER_DESCRIPTORS.map(({ kind }) => ({
    provider: kind,
    instanceId: kind,
    driver: kind,
    status: kind === "opencode" ? "error" : "ready",
    available: kind !== "opencode",
    authStatus: kind === "claudeAgent" ? "unauthenticated" : "authenticated",
    checkedAt: "2026-09-16T21:46:18.000Z",
    ...(kind === "opencode"
      ? { message: "OpenCode CLI (`opencode`) is not installed or not on PATH." }
      : {}),
  }));
});

// Lattice lists every provider as a provider-picker row (its installation beside a
// visibility switch); the fork has no enablement switches (7eabd821e).
function providerTitle(kind: string) {
  return PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.kind === kind)!.displayName;
}

function pickerSwitch(name: string) {
  return page.getByRole("switch", { name, exact: true });
}

function pickerRow(name: string) {
  return pickerSwitch(name).element().parentElement!;
}

it("saves provider CPU priority opt-out and exposes reset to the default", async () => {
  const updateSettings = vi.fn();
  const result = await render(
    <ProvidersSettingsPanel {...props} updateSettings={updateSettings} />,
  );
  const control = page.getByRole("switch", { name: "Keep Synara responsive" });
  await expect.element(control).toBeChecked();
  await control.click();
  expect(updateSettings).toHaveBeenCalledWith({ lowerProviderProcessPriority: false });
  await result.rerender(
    <>
      <ProvidersSettingsPanel
        {...props}
        settings={{ ...props.settings, lowerProviderProcessPriority: false }}
        updateSettings={updateSettings}
      />
    </>,
  );
  await page.getByRole("button", { name: "Reset Keep Synara responsive to default" }).click();
  expect(updateSettings).toHaveBeenLastCalledWith({ lowerProviderProcessPriority: true });
  expect(control.element().closest('[data-slot="settings-row"]')?.textContent).toContain(
    "Restart existing sessions",
  );
});

it("shows each provider's installation beside its picker switch", async () => {
  await render(<ProvidersSettingsPanel {...props} />);
  const openCode = t("settings:isUnavailableInTheProviderPicker", {
    value0: providerTitle("opencode"),
  });
  expect(pickerRow(openCode).textContent).toContain(t("lattice:cLINotInstalled"));
  await expect.element(pickerSwitch(openCode)).toBeDisabled();
  const codex = t("settings:showInTheProviderPicker", { value0: providerTitle("codex") });
  expect(pickerRow(codex).textContent).toContain(t("settings:installed"));
  await expect.element(pickerSwitch(codex)).toBeChecked();
});

it("reports Claude as installed and visible when only a secondary account is ready", async () => {
  harness.statuses = [
    ...harness.statuses.filter((status) => status.provider !== "claudeAgent"),
    {
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "claudeAgent",
      enabled: false,
      available: false,
      authStatus: "unknown",
      status: "warning",
      checkedAt: "2026-09-16T21:46:18.000Z",
    },
    {
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "work_claude",
      enabled: true,
      available: true,
      authStatus: "authenticated",
      status: "ready",
      checkedAt: "2026-09-16T21:46:18.000Z",
    },
  ];
  await render(
    <ProvidersSettingsPanel
      {...props}
      settings={{
        ...props.settings,
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", displayName: "Privat", enabled: false },
          work_claude: { driver: "claudeAgent", displayName: "Work", enabled: true },
        },
      }}
    />,
  );

  const claude = t("settings:showInTheProviderPicker", { value0: providerTitle("claudeAgent") });
  expect(pickerRow(claude).textContent).toContain(t("settings:installed"));
  await expect.element(pickerSwitch(claude)).toBeChecked();
});

it("does not report cached provider health as installed before reconciliation", async () => {
  harness.reconciled = false;
  await render(<ProvidersSettingsPanel {...props} />);
  await expect.element(page.getByText(t("lattice:checkingInstalledCLIs"))).toBeVisible();
  expect(document.body.textContent).not.toContain(
    t("lattice:installed", { availableProviderCount: PROVIDER_DESCRIPTORS.length - 1 }),
  );
});

it("picks up a provider installed outside Synara once its status refreshes", async () => {
  const screen = await render(<ProvidersSettingsPanel {...props} />);
  const title = providerTitle("opencode");
  await expect
    .element(pickerSwitch(t("settings:isUnavailableInTheProviderPicker", { value0: title })))
    .toBeDisabled();
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "opencode"
      ? { ...status, status: "ready", available: true, message: "OpenCode is ready." }
      : status,
  );
  await screen.rerender(<ProvidersSettingsPanel {...props} />);
  const shown = t("settings:showInTheProviderPicker", { value0: title });
  await expect.element(pickerSwitch(shown)).toBeEnabled();
  expect(pickerRow(shown).textContent).toContain(t("settings:installed"));
});

it("insets each Provider updates row from its outlined list and divides the rows", async () => {
  const behindLatest = {
    status: "behind_latest" as const,
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateCommand: "npm install -g provider@latest",
    canUpdate: true,
    checkedAt: "2026-09-16T21:46:18.000Z",
    message: "Update available.",
  };
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "codex" || status.provider === "claudeAgent"
      ? { ...status, version: "1.0.0", versionAdvisory: behindLatest }
      : status,
  );
  await render(<ProvidersSettingsPanel {...props} />);

  const updatesRow = page
    .getByRole("heading", { name: "Provider updates", exact: true })
    .element()
    .closest('[data-slot="settings-row"]')!;
  const list = updatesRow.querySelector<HTMLElement>(":scope > div:last-child")!;
  const rows = [...list.querySelectorAll<HTMLElement>(':scope > [data-slot="settings-row"]')];
  expect(rows).toHaveLength(2);

  const listBox = list.getBoundingClientRect();
  for (const row of rows) {
    const title = row.querySelector('[data-slot="settings-row-title"]')!.getBoundingClientRect();
    expect(title.left - listBox.left).toBeGreaterThanOrEqual(12);
    const action = row.querySelector('[data-slot="settings-actions"]')!.getBoundingClientRect();
    expect(listBox.right - action.right).toBeGreaterThanOrEqual(12);
  }
  expect(getComputedStyle(rows[0]!).borderTopWidth).toBe("0px");
  expect(getComputedStyle(rows[1]!).borderTopWidth).toBe("1px");
});
