import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Effect, type ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "./config.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeSynaraHomeRuntime } from "./orchestration/testing/synaraHomeFixture.ts";
import { importThreadsFromHome } from "./threadHomeImport.ts";

type HomeRuntime = ReturnType<typeof makeSynaraHomeRuntime>;
type HomeServices = HomeRuntime extends ManagedRuntime.ManagedRuntime<infer R, unknown> ? R : never;

const modelSelection: ModelSelection = { provider: "claudeAgent", model: "claude-sonnet-4-5" };
const createdAt = "2026-01-02T03:04:05.000Z";

const tempDirs: string[] = [];
const runtimes: HomeRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function openHome(baseDir = makeTempDir("synara-home-")) {
  const runtime = makeSynaraHomeRuntime(baseDir);
  runtimes.push(runtime);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const config = await runtime.runPromise(Effect.service(ServerConfig));
  const run = <A, E>(effect: Effect.Effect<A, E, HomeServices>) => runtime.runPromise(effect);
  const dispatch = (command: OrchestrationCommand) => run(engine.dispatch(command));
  const close = async () => {
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await runtime.dispose();
  };
  return { baseDir, config, runtime, engine, run, dispatch, close };
}

type Home = Awaited<ReturnType<typeof openHome>>;

let commandCounter = 0;
const commandId = () => CommandId.makeUnsafe(`test-command-${++commandCounter}`);

async function createProject(home: Home, id: string, workspaceRoot: string) {
  await home.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId: ProjectId.makeUnsafe(id),
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: modelSelection,
    createdAt,
  });
}

async function createThread(
  home: Home,
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly title?: string;
    readonly messages?: ReadonlyArray<{
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly text: string;
    }>;
    readonly createdAt?: string;
  },
) {
  const threadId = ThreadId.makeUnsafe(input.id);
  await home.dispatch({
    type: "thread.create",
    commandId: commandId(),
    threadId,
    projectId: ProjectId.makeUnsafe(input.projectId),
    title: input.title ?? `Thread ${input.id}`,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: input.createdAt ?? createdAt,
  });
  if (input.messages && input.messages.length > 0) {
    await home.dispatch({
      type: "thread.messages.import",
      commandId: commandId(),
      threadId,
      messages: input.messages.map((message, index) => ({
        messageId: MessageId.makeUnsafe(message.id),
        role: message.role,
        text: message.text,
        createdAt: `2026-01-02T03:0${5 + index}:00.000Z`,
        updatedAt: `2026-01-02T03:0${5 + index}:00.000Z`,
      })),
      createdAt: "2026-01-02T03:30:00.000Z",
    });
  }
}

const runImport = (target: Home, source: Home | string) =>
  target.run(
    importThreadsFromHome({
      sourceHomeDir: typeof source === "string" ? source : source.baseDir,
      targetBaseDir: target.baseDir,
      targetStateDir: target.config.stateDir,
      targetAttachmentsDir: target.config.attachmentsDir,
    }),
  );

const readThread = (home: Home, threadId: string) =>
  home.run(
    Effect.flatMap(Effect.service(ProjectionSnapshotQuery), (query) =>
      query.getThreadDetailForExportById(ThreadId.makeUnsafe(threadId)),
    ),
  );

const listThreads = (home: Home) =>
  home.run(home.engine.getReadModel()).then((model) => model.threads);

const eventCount = (home: Home) =>
  home.run(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
      sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM orchestration_events`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      ),
    ),
  );

/** Content and metadata of every file under a directory, for "never written" checks. */
function fingerprintTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const stat = fs.statSync(path);
      const hash = createHash("sha256").update(fs.readFileSync(path)).digest("hex");
      result[nodePath.relative(root, path)] = `${stat.size}:${stat.mtimeMs}:${hash}`;
    }
  };
  walk(root);
  return result;
}

describe("importThreadsFromHome", () => {
  it("imports every live and archived source thread into an empty target with its transcript", async () => {
    const workspaceRoot = makeTempDir("synara-workspace-");
    const source = await openHome();
    await createProject(source, "project-source", workspaceRoot);
    await createThread(source, {
      id: "thread-live",
      projectId: "project-source",
      title: "Live thread",
      messages: [
        { id: "message-user", role: "user", text: "Explain the proof" },
        { id: "message-assistant", role: "assistant", text: "Here is the proof" },
      ],
    });
    const attachmentId = "thread-live-0b8e1f43-4d1a-4a8e-9a39-111111111111";
    fs.writeFileSync(nodePath.join(source.config.attachmentsDir, `${attachmentId}.png`), "png!");
    await source.dispatch({
      type: "thread.messages.import",
      commandId: commandId(),
      threadId: ThreadId.makeUnsafe("thread-live"),
      messages: [
        {
          messageId: MessageId.makeUnsafe("message-image"),
          role: "user",
          text: "See figure",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "figure.png",
              mimeType: "image/png",
              sizeBytes: 4,
            },
          ],
          createdAt: "2026-01-02T03:20:00.000Z",
          updatedAt: "2026-01-02T03:20:00.000Z",
        },
      ],
      createdAt: "2026-01-02T03:31:00.000Z",
    });
    await createThread(source, { id: "thread-archived", projectId: "project-source" });
    await source.dispatch({
      type: "thread.archive",
      commandId: commandId(),
      threadId: ThreadId.makeUnsafe("thread-archived"),
    });
    await createThread(source, { id: "thread-deleted", projectId: "project-source" });
    await source.dispatch({
      type: "thread.delete",
      commandId: commandId(),
      threadId: ThreadId.makeUnsafe("thread-deleted"),
    });

    // The source server stays open: it holds its database under EXCLUSIVE
    // locking, so the import must read it through a file copy.
    const target = await openHome();
    const result = await runImport(target, source);

    expect(result.importedThreadIds.toSorted()).toEqual(["thread-archived", "thread-live"]);
    expect(result.failedThreadIds).toEqual([]);
    expect(result.createdProjectIds).toEqual(["project-source"]);

    const imported = await readThread(target, "thread-live");
    expect(imported._tag).toBe("Some");
    if (imported._tag !== "Some") return;
    expect(imported.value.title).toBe("Live thread");
    const sourceThread = await readThread(source, "thread-live");
    expect(imported.value.modelSelection).toEqual(
      sourceThread._tag === "Some" ? sourceThread.value.modelSelection : null,
    );
    expect(imported.value.createdAt).toBe(createdAt);
    expect(imported.value.projectId).toBe("project-source");
    expect(
      imported.value.messages.map((message) => [
        message.id,
        message.role,
        message.text,
        message.createdAt,
      ]),
    ).toEqual([
      ["message-user", "user", "Explain the proof", "2026-01-02T03:05:00.000Z"],
      ["message-assistant", "assistant", "Here is the proof", "2026-01-02T03:06:00.000Z"],
      ["message-image", "user", "See figure", "2026-01-02T03:20:00.000Z"],
    ]);
    expect(imported.value.messages[2]?.attachments?.[0]?.id).toBe(attachmentId);
    expect(
      fs.readFileSync(nodePath.join(target.config.attachmentsDir, `${attachmentId}.png`), "utf8"),
    ).toBe("png!");
    expect(imported.value.session).toBeNull();

    const threads = await listThreads(target);
    expect(threads.find((thread) => thread.id === "thread-archived")?.archivedAt).not.toBeNull();
    expect(threads.some((thread) => thread.id === "thread-deleted")).toBe(false);
    const model = await target.run(target.engine.getReadModel());
    expect(model.projects.find((project) => project.id === "project-source")?.workspaceRoot).toBe(
      workspaceRoot,
    );
  });

  it("leaves the target's own threads untouched and maps projects by workspace root", async () => {
    const workspaceRoot = makeTempDir("synara-workspace-");
    const source = await openHome();
    await createProject(source, "project-classic", workspaceRoot);
    await createThread(source, {
      id: "thread-classic",
      projectId: "project-classic",
      messages: [{ id: "classic-user", role: "user", text: "from classic" }],
    });
    await source.close();

    const target = await openHome();
    // Same folder spelled with a trailing separator, under another project id.
    await createProject(target, "project-native", `${workspaceRoot}/`);
    await createThread(target, {
      id: "thread-native",
      projectId: "project-native",
      messages: [{ id: "native-user", role: "user", text: "from native" }],
    });
    const nativeBefore = await readThread(target, "thread-native");

    const result = await runImport(target, source.baseDir);

    expect(result.importedThreadIds).toEqual(["thread-classic"]);
    expect(result.createdProjectIds).toEqual([]);
    const classic = await readThread(target, "thread-classic");
    expect(classic._tag === "Some" && classic.value.projectId).toBe("project-native");
    expect(await readThread(target, "thread-native")).toEqual(nativeBefore);
    const model = await target.run(target.engine.getReadModel());
    expect(model.projects.filter((project) => project.deletedAt === null).map((p) => p.id)).toEqual(
      ["project-native"],
    );
  });

  it("adds nothing on a second run", async () => {
    const workspaceRoot = makeTempDir("synara-workspace-");
    const source = await openHome();
    await createProject(source, "project-source", workspaceRoot);
    await createThread(source, {
      id: "thread-once",
      projectId: "project-source",
      messages: [{ id: "once-user", role: "user", text: "hello" }],
    });
    const target = await openHome();

    const first = await runImport(target, source);
    const eventsAfterFirst = await eventCount(target);
    const second = await runImport(target, source);

    expect(first.importedThreadIds).toEqual(["thread-once"]);
    expect(second.importedThreadIds).toEqual([]);
    expect(second.createdProjectIds).toEqual([]);
    expect(second.skippedExistingCount).toBe(1);
    expect(await eventCount(target)).toBe(eventsAfterFirst);
  });

  it("does not resurrect a thread the target deleted", async () => {
    const workspaceRoot = makeTempDir("synara-workspace-");
    const source = await openHome();
    await createProject(source, "project-source", workspaceRoot);
    await createThread(source, { id: "thread-shared", projectId: "project-source" });
    await source.close();

    const target = await openHome();
    await createProject(target, "project-source", workspaceRoot);
    await createThread(target, { id: "thread-shared", projectId: "project-source" });
    await target.dispatch({
      type: "thread.delete",
      commandId: commandId(),
      threadId: ThreadId.makeUnsafe("thread-shared"),
    });

    const result = await runImport(target, source.baseDir);

    expect(result.importedThreadIds).toEqual([]);
    expect(result.skippedExistingCount).toBe(1);
    expect(
      (await listThreads(target)).find((thread) => thread.id === "thread-shared")?.deletedAt,
    ).not.toBeNull();
  });

  it("never writes to the source home", async () => {
    const workspaceRoot = makeTempDir("synara-workspace-");
    const source = await openHome();
    await createProject(source, "project-source", workspaceRoot);
    await createThread(source, {
      id: "thread-readonly",
      projectId: "project-source",
      messages: [{ id: "readonly-user", role: "user", text: "keep me" }],
    });
    await source.close();
    const before = fingerprintTree(source.baseDir);

    const target = await openHome();
    const result = await runImport(target, source.baseDir);

    expect(result.importedThreadIds).toEqual(["thread-readonly"]);
    expect(fingerprintTree(source.baseDir)).toEqual(before);
    expect(
      fs
        .readdirSync(target.config.stateDir)
        .filter((entry) => entry.startsWith(".thread-home-import-")),
    ).toEqual([]);
  });

  it("skips a missing source home and the target's own home", async () => {
    const target = await openHome();
    expect((await runImport(target, makeTempDir("synara-empty-"))).skippedReason).toMatch(
      /no Synara database/,
    );
    expect((await runImport(target, target.baseDir)).skippedReason).toMatch(/own home/);
  });
});
