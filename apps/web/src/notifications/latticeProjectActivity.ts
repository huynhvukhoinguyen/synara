import type { ProjectId } from "@synara/contracts";
import { hasUnseenCompletion, isThreadActivelyWorking } from "../components/Sidebar.logic";
import { canSessionAnswerPendingRequests } from "../session-logic";
import type { SidebarThreadSummary } from "../types";

export const SYNARA_PROJECT_AGENT_ACTIVITY = "synara:project-agent-activity";

export function summarizeLatticeProjectActivity(
  threads: readonly SidebarThreadSummary[],
  projectIds: ReadonlySet<ProjectId>,
) {
  let running = false;
  let waiting = false;
  let completedUnread = false;
  for (const thread of threads) {
    if (!projectIds.has(thread.projectId) || thread.archivedAt != null) continue;
    const awaiting =
      (thread.hasPendingApprovals || thread.hasPendingUserInput) &&
      canSessionAnswerPendingRequests(thread.session);
    const working =
      isThreadActivelyWorking(thread) ||
      thread.session?.status === "connecting" ||
      thread.pendingBackgroundWorkCount > 0;
    waiting ||= awaiting;
    running ||= working;
    completedUnread ||=
      !thread.parentThreadId &&
      !working &&
      !awaiting &&
      thread.latestTurn?.state === "completed" &&
      hasUnseenCompletion(thread);
  }
  return { running, waiting, completedUnread };
}
