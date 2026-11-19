// FILE: serverDisabledProviders.ts
// Purpose: The fork keeps no `disabledProviders` app setting: an agent is switched off in
//          server settings (`providers[kind].enabled`). Upstream's settings pages read and
//          write `disabledProviders`, so they go through these helpers instead.
// Layer: Web settings support
// Exports: serverDisabledProviders, useServerDisabledProviders, writeServerDisabledProviders

import type { ProviderKind, ServerSettings } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { serverSettingsQueryOptions } from "./serverReactQuery";

const NO_DISABLED_PROVIDERS: ReadonlyArray<ProviderKind> = [];

/** Agents the server settings switch off, in descriptor order. */
export function serverDisabledProviders(
  serverSettings: Pick<ServerSettings, "providers"> | null | undefined,
): ReadonlyArray<ProviderKind> {
  if (!serverSettings) return NO_DISABLED_PROVIDERS;
  const disabled = PROVIDER_DESCRIPTORS.map((item) => item.kind).filter(
    (kind) => serverSettings.providers[kind]?.enabled === false,
  );
  return disabled.length > 0 ? disabled : NO_DISABLED_PROVIDERS;
}

export function useServerDisabledProviders(): ReadonlyArray<ProviderKind> {
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  return useMemo(() => serverDisabledProviders(settingsQuery.data), [settingsQuery.data]);
}

/** Writes the switched-off agents to server settings and waits for the refetch. */
export async function writeServerDisabledProviders(
  queryClient: QueryClient,
  disabledProviders: ReadonlyArray<ProviderKind>,
): Promise<void> {
  const current = await queryClient.fetchQuery(serverSettingsQueryOptions());
  const disabled = new Set(disabledProviders);
  const providers = Object.fromEntries(
    Object.entries(current.providers).map(([kind, entry]) => [
      kind,
      { ...entry, enabled: !disabled.has(kind as ProviderKind) },
    ]),
  ) as ServerSettings["providers"];
  await ensureNativeApi().server.updateSettings({ providers });
  await queryClient.invalidateQueries({ queryKey: serverSettingsQueryOptions().queryKey });
}
