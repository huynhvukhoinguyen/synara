import type { ProjectId } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { embedWorkspaceMatches, readEmbedMode } from "../embedMode";
import { t } from "../i18n";
import { createOrRecoverProjectFromPath } from "../lib/projectCreation";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";

export function useEmbeddedWorkspaceProject(): {
  embedMode: ReturnType<typeof readEmbedMode>;
  projectId: ProjectId | null;
  bindingError: string | null;
} {
  const embedMode = useMemo(() => readEmbedMode(), []);
  const workspaceRoot = embedMode?.workspaceRoot ?? null;
  const matchingProject = useStore((store) =>
    embedMode
      ? (store.projects.find((project) => embedWorkspaceMatches(embedMode, project.cwd)) ?? null)
      : null,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(matchingProject?.id ?? null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const bindingStartedRootRef = useRef<string | null>(null);

  useEffect(() => {
    if (!workspaceRoot || !embedMode || matchingProject) return;
    if (bindingStartedRootRef.current === workspaceRoot) return;
    bindingStartedRootRef.current = workspaceRoot;
    const api = readNativeApi();
    if (!api) {
      setBindingError(t("lattice:theLocalAgentConnectionIsUnavailable"));
      return;
    }
    void (async () => {
      try {
        const initialSnapshot = await api.orchestration.getShellSnapshot();
        useStore.getState().syncServerShellSnapshot(initialSnapshot);
        const existingProject =
          initialSnapshot.projects.find(
            (project) =>
              project.kind === "project" && embedWorkspaceMatches(embedMode, project.workspaceRoot),
          ) ?? null;
        const result = existingProject
          ? {
              projectId: existingProject.id,
              project: existingProject,
              snapshot: initialSnapshot,
              created: false,
            }
          : await createOrRecoverProjectFromPath({
              api,
              workspaceRoot,
              reuseExistingWorkspaceRoot: true,
              loadSnapshot: () => api.orchestration.getShellSnapshot(),
            });
        if (result.snapshot) {
          useStore.getState().syncServerShellSnapshot(result.snapshot);
        }
        setProjectId(result.projectId);
        setBindingError(null);
      } catch (error) {
        setBindingError(
          error instanceof Error ? error.message : t("lattice:theLatticeProjectCouldNotBeBound"),
        );
      }
    })();
  }, [embedMode, matchingProject, workspaceRoot]);

  useEffect(() => {
    if (matchingProject) {
      setProjectId(matchingProject.id);
      setBindingError(null);
    }
  }, [matchingProject]);

  // Lattice owns the bound project's extra folders: the paper's linked research
  // folder, or none. The server canonicalizes paths, so compare as workspace roots
  // and dispatch each wanted set once.
  const researchFolder = embedMode?.researchFolder;
  const currentFolders = matchingProject?.additionalFolders;
  const foldersDispatchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (researchFolder === undefined || !matchingProject) return;
    const wanted = researchFolder ? [researchFolder] : [];
    const current = currentFolders ?? [];
    const same =
      wanted.length === current.length &&
      wanted.every((folder, index) => workspaceRootsEqual(folder, current[index]!));
    const key = `${matchingProject.id}\n${wanted.join("\n")}`;
    if (same || foldersDispatchedRef.current === key) return;
    foldersDispatchedRef.current = key;
    const api = readNativeApi();
    if (!api) return;
    void api.orchestration
      .dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: matchingProject.id,
        additionalFolders: wanted,
      })
      .catch((error: unknown) => {
        // The paper stays usable without the research folder; Lattice validates the
        // link before sending it, so this is a stale or vanished folder.
        console.warn("Could not give the agent the linked research folder.", error);
      });
  }, [currentFolders, matchingProject, researchFolder]);

  return { embedMode, projectId, bindingError };
}
