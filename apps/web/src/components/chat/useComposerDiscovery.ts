import {
  type ProjectEntry,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderMentionReference,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { isLocalFolderMentionQuery } from "~/lib/localFolderMentions";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import {
  providerCommandsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsNativeSlashCommandDiscovery,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
  supportsThreadCompaction,
} from "~/lib/providerDiscoveryReactQuery";
import { type ComposerTrigger } from "../../composer-logic";
import {
  hasProviderNativeSlashCommand,
  providerSupportsTextNativeReviewCommand,
} from "../../composerSlashCommands";

const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_FOLDERS: ReadonlyArray<string> = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

const EMPTY_COMPOSER_PLUGIN_SUGGESTIONS: ComposerPluginSuggestion[] = [];
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
interface ComposerDiscoveryInput {
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  selectedProviderInstanceId: ProviderInstanceId;
  composerTrigger: ComposerTrigger | null;
  composerCommandPicker: "fork-target" | "review-target" | null;
  providerModelDiscoveryCwd: string | null;
  providerOptionsForDispatch: ProviderStartOptions | undefined;
  gitCwd: string | null;
  /** The project's extra folders (Lattice's linked research folder); `@` searches them too. */
  additionalFolders?: ReadonlyArray<string>;
  piAgentDir: string;
  ompAgentDir: string;
  discoverNativeCompaction?: boolean;
}

export function useComposerDiscovery({
  threadId,
  selectedProvider,
  selectedProviderInstanceId,
  composerTrigger,
  composerCommandPicker,
  providerModelDiscoveryCwd,
  providerOptionsForDispatch,
  gitCwd,
  additionalFolders = EMPTY_FOLDERS,
  piAgentDir,
  ompAgentDir,
  discoverNativeCompaction,
}: ComposerDiscoveryInput) {
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const mentionTriggerQuery = composerTrigger?.kind === "mention" ? composerTrigger.query : "";
  const isMentionTrigger = composerTriggerKind === "mention";

  const isLocalFolderBrowserOpen =
    composerCommandPicker === null &&
    isMentionTrigger &&
    isLocalFolderMentionQuery(mentionTriggerQuery);
  const isSkillTrigger = composerTriggerKind === "skill";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    mentionTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectiveMentionQuery = mentionTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const composerSkillCwd = providerModelDiscoveryCwd;
  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider, selectedProviderInstanceId),
  );
  const providerCommandsQuery = useQuery(
    providerCommandsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: composerSkillCwd,
      threadId,
      binaryPath:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.binaryPath
          : selectedProvider === "devin"
            ? providerOptionsForDispatch?.devin?.binaryPath
            : null) ?? null,
      serverUrl:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.serverUrl
          : null) ?? null,
      experimentalWebSockets:
        selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.experimentalWebSockets
          : undefined,
      agentDir:
        selectedProvider === "pi"
          ? piAgentDir || null
          : selectedProvider === "omp"
            ? ompAgentDir || null
            : null,
      enabled:
        (composerTriggerKind === "slash-command" ||
          composerTriggerKind === "slash-model" ||
          discoverNativeCompaction === true) &&
        supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const canDiscoverProviderSkills =
    selectedProvider === "pi" ||
    selectedProvider === "omp" ||
    supportsSkillDiscovery(providerComposerCapabilitiesQuery.data);
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: composerSkillCwd,
      threadId,
      agentDir:
        selectedProvider === "pi"
          ? piAgentDir || null
          : selectedProvider === "omp"
            ? ompAgentDir || null
            : null,
      enabled:
        (isSkillTrigger ||
          composerTriggerKind === "slash-command" ||
          selectedProvider === "pi" ||
          selectedProvider === "omp") &&
        canDiscoverProviderSkills &&
        composerSkillCwd !== null,
    }),
  );
  const providerPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: composerSkillCwd,
      threadId,
      enabled:
        supportsPluginDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectiveMentionQuery,
      enabled: isMentionTrigger && !isLocalFolderBrowserOpen,
      // A bare `@` must already list project files; directories would crowd
      // out the files that ranking has nothing to rank yet.
      allowEmptyQuery: true,
      ...(effectiveMentionQuery.length === 0 ? { kind: "file" as const } : {}),
      limit: 80,
    }),
  );
  // Extra folders are searched on their own and listed after the primary
  // folder's hits. Their entries carry absolute paths (the mention then reads
  // `@/abs/path`), since a path relative to the primary folder would be wrong.
  const extraFolderQueries = useQueries({
    queries: additionalFolders.map((folder) =>
      projectSearchEntriesQueryOptions({
        cwd: folder,
        query: effectiveMentionQuery,
        enabled: isMentionTrigger && !isLocalFolderBrowserOpen,
        allowEmptyQuery: true,
        ...(effectiveMentionQuery.length === 0 ? { kind: "file" as const } : {}),
        limit: 40,
      }),
    ),
  });
  const primaryEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const extraFoldersStamp = extraFolderQueries.map((query) => query.dataUpdatedAt).join(",");
  const workspaceEntries = useMemo(() => {
    if (additionalFolders.length === 0) return primaryEntries;
    const extra = additionalFolders.flatMap((folder, index) => {
      const root = folder.replace(/\/+$/, "");
      return (extraFolderQueries[index]?.data?.entries ?? []).map(
        (entry): ProjectEntry => ({
          ...entry,
          path: `${root}/${entry.path}`,
          parentPath: entry.parentPath ? `${root}/${entry.parentPath}` : root,
        }),
      );
    });
    return [...primaryEntries, ...extra];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stamp stands for the query results, which are rebuilt each render
  }, [additionalFolders, primaryEntries, extraFoldersStamp]);

  // Keep plugin suggestions referentially stable so prompt-sync effects do not loop on rerender.
  const providerPlugins = useMemo(
    () =>
      providerPluginsQuery.data?.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => ({
          plugin,
          mention: {
            name: plugin.name,
            path: `plugin://${plugin.name}@${marketplace.name}`,
          } satisfies ProviderMentionReference,
        })),
      ) ?? EMPTY_COMPOSER_PLUGIN_SUGGESTIONS,
    [providerPluginsQuery.data],
  );
  const providerNativeCommands =
    providerCommandsQuery.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS;
  const providerNativeCommandNames = useMemo(
    () => providerNativeCommands.map((command) => command.name),
    [providerNativeCommands],
  );
  const effectiveComposerTrigger = useMemo(() => {
    if (
      composerTrigger?.kind === "slash-model" &&
      hasProviderNativeSlashCommand(selectedProvider, providerNativeCommandNames, "model")
    ) {
      return {
        ...composerTrigger,
        kind: "slash-command" as const,
        query: "model",
      };
    }
    return composerTrigger;
  }, [composerTrigger, providerNativeCommandNames, selectedProvider]);
  const effectiveComposerTriggerKind = effectiveComposerTrigger?.kind ?? null;
  const supportsTextNativeReviewCommand = useMemo(
    () => providerSupportsTextNativeReviewCommand(selectedProvider, providerNativeCommands),
    [providerNativeCommands, selectedProvider],
  );
  const providerSkills = providerSkillsQuery.data?.skills ?? EMPTY_PROVIDER_SKILLS;

  const isComposerMenuLoading =
    (composerTriggerKind === "mention" &&
      ((mentionTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching ||
        extraFolderQueries.some((query) => query.isFetching) ||
        providerPluginsQuery.isLoading ||
        providerPluginsQuery.isFetching)) ||
    (composerTriggerKind === "slash-command" &&
      (providerCommandsQuery.isLoading ||
        providerCommandsQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching)) ||
    (composerTriggerKind === "skill" &&
      (providerComposerCapabilitiesQuery.isLoading ||
        providerComposerCapabilitiesQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching));
  return {
    mentionTriggerQuery,
    isLocalFolderBrowserOpen,
    providerPlugins,
    providerNativeCommands,
    providerArtifacts: providerCommandsQuery.data?.artifacts,
    providerSkills,
    workspaceEntries,
    effectiveComposerTrigger,
    effectiveComposerTriggerKind,
    supportsTextNativeReviewCommand,
    isComposerMenuLoading,
    canCompactThread: supportsThreadCompaction(providerComposerCapabilitiesQuery.data),
    isNativeCommandDiscoveryPending:
      providerComposerCapabilitiesQuery.isPending ||
      (supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
        providerCommandsQuery.isPending) ||
      providerCommandsQuery.isFetching,
  };
}
