// FILE: threadHomeImport.ts
// Purpose: Union-import chat threads from another Synara home into this one.
// Layer: Startup hook — runs once the orchestration engine is up, before the
// server admits client commands.
//
// When SYNARA_IMPORT_THREADS_FROM_HOME names another Synara home (the directory
// SYNARA_HOME would name, holding userdata/state.sqlite), every thread of that
// home whose id this store has never seen is recreated here through ordinary
// engine commands: project.create when no project shares its workspace root,
// thread.create, thread.messages.import and, for archived threads,
// thread.archive. None of them starts, resumes or sends to a provider session,
// so the import never talks to a provider; the first message a user sends in an
// imported thread starts its provider session like any other turn.
//
// Merging raw events instead would be unsafe: the provider-command reactor
// durably replays every event after its cursor, so appended turn-start events
// would resend old prompts. The source home is only ever read. Its database is
// copied file by file into a private staging directory (the source server may
// hold it under EXCLUSIVE locking, which rules out a second connection, and a
// read-only SQLite connection could still touch its WAL index), the copy is
// migrated to this build's schema, and its projections are read through the
// regular snapshot query.
//
// Idempotence comes from thread ids: a source thread is skipped when its id
// appears in this store's event log, its projections, or the purged-thread
// tombstones, so deleted threads are never resurrected and a second run adds
// nothing.
//
// A thread this store took from an earlier import and has not touched since (no
// turn, no session, no message of its own) also receives the source messages
// it lacks, so a conversation that went on in the source home stays current.
// Any thread with local activity is left alone.
//
// Lattice sets the variable on every launch, so the source is stamped: the size
// and mtime of its database and WAL plus the WAL header salts. A run that
// finished cleanly records the stamp, and the next start skips the copy while
// the stamp still matches. A run that brought anything over writes
// thread-home-import-result.json for the host to show and delete.

import { join, resolve } from "node:path";

import {
  CommandId,
  ProjectId,
  type OrchestrationProject,
  type OrchestrationThread,
  type ThreadHandoffImportedMessage,
  type ThreadId,
} from "@synara/contracts";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import { Data, Effect, FileSystem, Layer, Option, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveAttachmentPath } from "./attachmentStore.ts";
import { copyLiveDatabase } from "./betaImport.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite.ts";

export const SYNARA_IMPORT_THREADS_FROM_HOME_ENV = "SYNARA_IMPORT_THREADS_FROM_HOME";
/** In the target state dir: the source stamp of the last clean run. */
export const THREAD_HOME_IMPORT_STAMP_FILE_NAME = "thread-home-import-stamp.json";
/**
 * In the target state dir, written after a run that brought threads over:
 * { version: 1, completedAt, imported, appended }. The host reads and deletes it;
 * counts from runs it has not consumed yet are added up.
 */
export const THREAD_HOME_IMPORT_RESULT_FILE_NAME = "thread-home-import-result.json";

const IMPORT_COMMAND_ID_PREFIX = "thread-home-import:";

class ThreadHomeImportError extends Data.TaggedError("ThreadHomeImportError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

// Keeps one command, and its event-store transaction, bounded on long transcripts.
const MESSAGE_IMPORT_BATCH_SIZE = 200;

export interface ThreadHomeImportResult {
  readonly importedThreadIds: ReadonlyArray<ThreadId>;
  readonly appendedThreadIds: ReadonlyArray<ThreadId>;
  readonly createdProjectIds: ReadonlyArray<ProjectId>;
  readonly skippedExistingCount: number;
  readonly failedThreadIds: ReadonlyArray<ThreadId>;
  readonly skippedReason?: string;
}

const skippedImport = (skippedReason: string): ThreadHomeImportResult => ({
  importedThreadIds: [],
  appendedThreadIds: [],
  createdProjectIds: [],
  skippedExistingCount: 0,
  failedThreadIds: [],
  skippedReason,
});

const newCommandId = () =>
  CommandId.makeUnsafe(`${IMPORT_COMMAND_ID_PREFIX}${crypto.randomUUID()}`);

// Sidechats expire with their source conversation and hold no history of their
// own worth keeping, so they stay behind.
const isImportableSourceThread = (thread: OrchestrationThread) =>
  thread.deletedAt === null && thread.sidechatSourceThreadId == null && !thread.sidechatContext;

const toImportedMessages = (
  thread: OrchestrationThread,
): ReadonlyArray<ThreadHandoffImportedMessage> =>
  thread.messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const attachments = message.attachments ?? [];
    if (message.text.trim().length === 0 && attachments.length === 0) return [];
    return [
      {
        messageId: message.id,
        role: message.role,
        text: message.text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(message.dispatchOrigin !== undefined ? { dispatchOrigin: message.dispatchOrigin } : {}),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    ];
  });

/** Copies the attachment files imported messages reference; an existing target is kept. */
const copyMessageAttachments = Effect.fnUntraced(function* (input: {
  readonly messages: ReadonlyArray<ThreadHandoffImportedMessage>;
  readonly sourceAttachmentsDir: string;
  readonly targetAttachmentsDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  for (const message of input.messages) {
    for (const attachment of message.attachments ?? []) {
      const sourcePath = resolveAttachmentPath({
        attachmentsDir: input.sourceAttachmentsDir,
        attachment,
      });
      const targetPath = resolveAttachmentPath({
        attachmentsDir: input.targetAttachmentsDir,
        attachment,
      });
      if (!sourcePath || !targetPath) continue;
      // A missing attachment renders as unavailable; its message still imports.
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(sourcePath)) || (yield* fs.exists(targetPath))) return;
        yield* fs.copyFile(sourcePath, targetPath);
      }).pipe(Effect.ignore);
    }
  }
});

/**
 * Identifies the source database state without opening it: a checkpoint
 * changes the main file, an append changes the WAL, a WAL restart its salts.
 */
const readSourceStamp = Effect.fnUntraced(function* (sourceDbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const walPath = `${sourceDbPath}-wal`;
  const describeFile = (path: string) =>
    fs.stat(path).pipe(
      Effect.map((info) => ({
        size: String(info.size),
        mtimeMs: info.mtime?.getTime() ?? null,
      })),
      Effect.orElseSucceed(() => null),
    );
  const walSalts = yield* Effect.scoped(
    Effect.gen(function* () {
      const wal = yield* fs.open(walPath, { flag: "r" });
      const header = yield* wal.readAlloc(32);
      return header && header.length >= 24
        ? Buffer.from(header.subarray(16, 24)).toString("hex")
        : null;
    }),
  ).pipe(Effect.orElseSucceed(() => null));
  return JSON.stringify({
    version: 1,
    sourceDbPath,
    main: yield* describeFile(sourceDbPath),
    wal: yield* describeFile(walPath),
    walSalts,
  });
});

const writeFileAtomic = Effect.fnUntraced(function* (path: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const temporaryPath = `${path}.tmp-${process.pid}`;
  yield* fs.writeFileString(temporaryPath, contents);
  yield* fs.rename(temporaryPath, path);
});

/** Adds this run's counts to a result file the host has not consumed yet. */
const recordImportResult = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly imported: number;
  readonly appended: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const previous = yield* fs.readFileString(input.path).pipe(
    Effect.map((text) => JSON.parse(text) as { imported?: unknown; appended?: unknown }),
    Effect.orElseSucceed((): { imported?: unknown; appended?: unknown } => ({})),
  );
  const count = (value: unknown) => (typeof value === "number" && value >= 0 ? value : 0);
  yield* writeFileAtomic(
    input.path,
    `${JSON.stringify({
      version: 1,
      completedAt: new Date().toISOString(),
      imported: count(previous.imported) + input.imported,
      appended: count(previous.appended) + input.appended,
    })}\n`,
  );
});

export const importThreadsFromHome = Effect.fn("importThreadsFromHome")(function* (input: {
  readonly sourceHomeDir: string;
  readonly targetBaseDir: string;
  readonly targetStateDir: string;
  readonly targetAttachmentsDir: string;
  readonly platform?: NodeJS.Platform;
}) {
  const platform = input.platform ?? process.platform;
  const sourceHomeDir = resolve(input.sourceHomeDir);
  const sourceStateDir = join(sourceHomeDir, "userdata");
  const sourceDbPath = join(sourceStateDir, "state.sqlite");
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(sourceDbPath))) {
    return skippedImport(`no Synara database at ${sourceDbPath}`);
  }
  if ((yield* fs.realPath(sourceHomeDir)) === (yield* fs.realPath(input.targetBaseDir))) {
    return skippedImport("source home is this server's own home");
  }
  const stampPath = join(input.targetStateDir, THREAD_HOME_IMPORT_STAMP_FILE_NAME);
  const stampBefore = yield* readSourceStamp(sourceDbPath);
  const recordedStamp = yield* fs.readFileString(stampPath).pipe(Effect.orElseSucceed(() => null));
  if (recordedStamp === stampBefore) {
    return skippedImport("source unchanged since the last import");
  }

  const engine = yield* OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;

  const stagingDir = yield* fs.makeTempDirectoryScoped({
    directory: input.targetStateDir,
    prefix: ".thread-home-import-",
  });
  const stagedDbPath = yield* Effect.try({
    try: () => copyLiveDatabase(sourceDbPath, join(stagingDir, "source")),
    catch: (cause) =>
      new ThreadHomeImportError({ message: "Failed to copy the source database", cause }),
  });

  // The staged copy gets this build's migrations, so its projections read
  // through the same query code whatever version wrote the source. A source
  // newer than this build fails here and the import is skipped. The query
  // layer must be fresh: built from the server's memo map it would resolve
  // to the instance already bound to this server's own database.
  const sourceServices = yield* Layer.build(
    Layer.fresh(OrchestrationProjectionSnapshotQueryLive).pipe(
      Layer.provide(makeSqlitePersistenceLive(stagedDbPath)),
    ),
  );
  const sourceQuery = ServiceMap.get(sourceServices, ProjectionSnapshotQuery);
  const sourceModel = yield* sourceQuery.getCommandReadModel();

  const threadIdKnown = (threadId: ThreadId) =>
    sql<{ readonly known: number }>`
        SELECT (
          EXISTS (
            SELECT 1 FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          )
          OR EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = ${threadId})
          OR EXISTS (SELECT 1 FROM profile_stats_deleted_threads WHERE thread_id = ${threadId})
        ) AS known
      `.pipe(Effect.map((rows) => rows[0]?.known === 1));
  const projectIdKnown = (projectId: ProjectId) =>
    sql<{ readonly known: number }>`
        SELECT EXISTS (
          SELECT 1 FROM orchestration_events
          WHERE aggregate_kind = 'project' AND stream_id = ${projectId}
        ) AS known
      `.pipe(Effect.map((rows) => rows[0]?.known === 1));

  // Oldest first, so a parent thread exists before the children that name it.
  const candidates = sourceModel.threads
    .filter(isImportableSourceThread)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const missing: Array<OrchestrationThread> = [];
  const known: Array<OrchestrationThread> = [];
  for (const thread of candidates) {
    if (yield* threadIdKnown(thread.id)) known.push(thread);
    else missing.push(thread);
  }

  // Created by an earlier import and untouched here since: no turn, no
  // session, no message that did not come from an import, not deleted.
  const importedAndUntouched = (threadId: ThreadId) =>
    sql<{ readonly imported: number; readonly touched: number }>`
      SELECT
        EXISTS (
          SELECT 1 FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND event_type = 'thread.created'
            AND command_id LIKE ${`${IMPORT_COMMAND_ID_PREFIX}%`}
        ) AS imported,
        EXISTS (
          SELECT 1 FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND (
              event_type LIKE 'thread.turn-%'
              OR event_type IN ('thread.session-set', 'thread.deleted')
              OR (
                event_type = 'thread.message-sent'
                AND (command_id IS NULL OR command_id NOT LIKE ${`${IMPORT_COMMAND_ID_PREFIX}%`})
              )
            )
        ) AS touched
    `.pipe(Effect.map((rows) => rows[0]?.imported === 1 && rows[0]?.touched === 0));
  const targetMessageIds = (threadId: ThreadId) =>
    sql<{ readonly messageId: string }>`
      SELECT message_id AS "messageId" FROM projection_thread_messages
      WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => new Set(rows.map((row) => row.messageId))));

  const sourceProjects = new Map(sourceModel.projects.map((project) => [project.id, project]));
  const targetProjectIds = new Map<ProjectId, ProjectId>();
  const createdProjectIds: Array<ProjectId> = [];

  const resolveTargetProject = Effect.fnUntraced(function* (sourceProject: OrchestrationProject) {
    const mapped = targetProjectIds.get(sourceProject.id);
    if (mapped) return mapped;
    const sameRootProjects = (yield* engine.getReadModel()).projects.filter(
      (project) =>
        project.deletedAt === null &&
        workspaceRootsEqual(project.workspaceRoot, sourceProject.workspaceRoot, { platform }),
    );
    const existing =
      sameRootProjects.find((project) => project.kind === sourceProject.kind) ??
      sameRootProjects[0];
    if (existing) {
      targetProjectIds.set(sourceProject.id, existing.id);
      return existing.id;
    }
    const projectId = (yield* projectIdKnown(sourceProject.id))
      ? ProjectId.makeUnsafe(crypto.randomUUID())
      : sourceProject.id;
    yield* engine.dispatch({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      kind: sourceProject.kind,
      title: sourceProject.title,
      workspaceRoot: sourceProject.workspaceRoot,
      createWorkspaceRootIfMissing: false,
      reuseExistingWorkspaceRoot: false,
      defaultModelSelection: sourceProject.defaultModelSelection,
      isPinned: sourceProject.isPinned,
      createdAt: sourceProject.createdAt,
    });
    targetProjectIds.set(sourceProject.id, projectId);
    createdProjectIds.push(projectId);
    return projectId;
  });

  const importMessages = Effect.fnUntraced(function* (
    thread: OrchestrationThread,
    messages: ReadonlyArray<ThreadHandoffImportedMessage>,
  ) {
    yield* copyMessageAttachments({
      messages,
      sourceAttachmentsDir: join(sourceStateDir, "attachments"),
      targetAttachmentsDir: input.targetAttachmentsDir,
    });
    for (let start = 0; start < messages.length; start += MESSAGE_IMPORT_BATCH_SIZE) {
      yield* engine.dispatch({
        type: "thread.messages.import",
        commandId: newCommandId(),
        threadId: thread.id,
        messages: messages.slice(start, start + MESSAGE_IMPORT_BATCH_SIZE),
        // The source thread's last activity time keeps imported threads in
        // their place in recency-sorted lists.
        createdAt: thread.updatedAt,
      });
    }
  });

  const appendToImportedThread = Effect.fnUntraced(function* (shell: OrchestrationThread) {
    if (!(yield* importedAndUntouched(shell.id))) return false;
    const detail = yield* sourceQuery.getThreadDetailForExportById(shell.id);
    if (Option.isNone(detail)) return false;
    const present = yield* targetMessageIds(shell.id);
    const messages = toImportedMessages(detail.value).filter(
      (message) => !present.has(message.messageId),
    );
    if (messages.length === 0) return false;
    yield* importMessages(detail.value, messages);
    return true;
  });

  const importThread = Effect.fnUntraced(function* (shell: OrchestrationThread) {
    const sourceProject = sourceProjects.get(shell.projectId);
    if (!sourceProject) return false;
    const detail = yield* sourceQuery.getThreadDetailForExportById(shell.id);
    if (Option.isNone(detail)) return false;
    const thread = detail.value;
    const projectId = yield* resolveTargetProject(sourceProject);
    const parentThreadId =
      thread.parentThreadId != null &&
      (yield* engine.getReadModel()).threads.some(
        (candidate) => candidate.id === thread.parentThreadId,
      )
        ? thread.parentThreadId
        : null;

    yield* engine.dispatch({
      type: "thread.create",
      commandId: newCommandId(),
      threadId: thread.id,
      projectId,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      envMode: thread.envMode,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      workingDirectory: thread.workingDirectory ?? null,
      associatedWorktreePath: thread.associatedWorktreePath ?? null,
      associatedWorktreeBranch: thread.associatedWorktreeBranch ?? null,
      associatedWorktreeRef: thread.associatedWorktreeRef ?? null,
      createBranchFlowCompleted: thread.createBranchFlowCompleted,
      isPinned: thread.isPinned,
      parentThreadId,
      ...(thread.creationSource ? { creationSource: thread.creationSource } : {}),
      subagentAgentId: thread.subagentAgentId ?? null,
      subagentNickname: thread.subagentNickname ?? null,
      subagentRole: thread.subagentRole ?? null,
      createdAt: thread.createdAt,
    });

    yield* importMessages(thread, toImportedMessages(thread));
    if (thread.archivedAt) {
      yield* engine.dispatch({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId: thread.id,
      });
    }
    return true;
  });

  const importedThreadIds: Array<ThreadId> = [];
  const failedThreadIds: Array<ThreadId> = [];
  for (const thread of missing) {
    // One thread the decider rejects must not keep the others out.
    const imported = yield* importThread(thread).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread home import skipped a thread", {
          threadId: thread.id,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (imported === true) importedThreadIds.push(thread.id);
    else if (imported === null) failedThreadIds.push(thread.id);
  }
  const appendedThreadIds: Array<ThreadId> = [];
  for (const thread of known) {
    const appended = yield* appendToImportedThread(thread).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread home import could not append to a thread", {
          threadId: thread.id,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (appended === true) appendedThreadIds.push(thread.id);
    else if (appended === null) failedThreadIds.push(thread.id);
  }

  if (importedThreadIds.length > 0 || appendedThreadIds.length > 0) {
    yield* recordImportResult({
      path: join(input.targetStateDir, THREAD_HOME_IMPORT_RESULT_FILE_NAME),
      imported: importedThreadIds.length,
      appended: appendedThreadIds.length,
    });
  }
  // Stamp only a clean run over a source that held still during the copy;
  // anything else runs again on the next start.
  if (failedThreadIds.length === 0 && (yield* readSourceStamp(sourceDbPath)) === stampBefore) {
    yield* writeFileAtomic(stampPath, stampBefore);
  }

  return {
    importedThreadIds,
    appendedThreadIds,
    createdProjectIds,
    skippedExistingCount: candidates.length - missing.length,
    failedThreadIds,
  } satisfies ThreadHomeImportResult;
}, Effect.scoped);
