// FILE: DroidAdapter.resume.test.ts
// Purpose: Covers that a Droid session is only advertised as resumable once Droid will keep it,
//          and that a session Droid no longer has is reported as resume-state-unavailable.
// Layer: Provider adapter tests
// Note: kept apart from DroidAdapter.test.ts because it mocks the Droid ACP runtime module.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import type * as Acp from "@agentclientprotocol/sdk";
import { Effect, Fiber, Layer, Schedule, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { AcpRequestError } from "../acp/AcpErrors.ts";
import type { DroidAcpRuntimeInput } from "../acp/DroidAcpSupport.ts";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { DroidAdapter } from "../Services/DroidAdapter.ts";
import { makeDroidAdapterLive } from "./DroidAdapter.ts";

// Models Factory Droid's session store: `session/new` writes the session right
// away, but closing a session that never received a message deletes it as an
// empty draft, and Droid's ACP process closes every session when it exits.
// Resuming a session it does not have fails the way Droid 1.12 answers it.
const droid = vi.hoisted(() => ({
  sessions: new Map<string, { hasRealContent: boolean }>(),
  spawns: [] as Array<{ resumeSessionId?: string }>,
  nextSessionNumber: 0,
  // When set, a prompt reaches Droid but its turn stays open until this settles.
  promptHeldUntil: undefined as Promise<void> | undefined,
}));

vi.mock("../acp/DroidAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/DroidAcpSupport.ts")>()),
  makeDroidAcpRuntime: (input: DroidAcpRuntimeInput) =>
    Effect.gen(function* () {
      droid.spawns.push(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {});
      let sessionId: string | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (sessionId !== undefined && droid.sessions.get(sessionId)?.hasRealContent === false) {
            droid.sessions.delete(sessionId);
          }
        }),
      );
      const runtime = makeFakeAcpSessionRuntime({
        prompt: () =>
          Effect.sync(() => {
            const stored = sessionId === undefined ? undefined : droid.sessions.get(sessionId);
            if (stored) stored.hasRealContent = true;
          }).pipe(
            Effect.andThen(Effect.promise(() => droid.promptHeldUntil ?? Promise.resolve())),
            Effect.as({ stopReason: "end_turn" } as Acp.PromptResponse),
          ),
      });
      const resumeSessionId = input.resumeSessionId;
      return {
        ...runtime,
        start: () =>
          resumeSessionId === undefined
            ? runtime.start().pipe(
                Effect.map((started) => {
                  droid.nextSessionNumber += 1;
                  sessionId = `droid-session-${droid.nextSessionNumber}`;
                  droid.sessions.set(sessionId, { hasRealContent: false });
                  return { ...started, sessionId };
                }),
              )
            : droid.sessions.has(resumeSessionId)
              ? runtime.start().pipe(
                  Effect.map((started) => {
                    sessionId = resumeSessionId;
                    return { ...started, sessionId, sessionSetupMethod: "resume" as const };
                  }),
                )
              : Effect.fail(
                  new AcpRequestError({
                    code: -32602,
                    errorMessage: "Invalid params: Unknown session identifier",
                    data: { sessionId: resumeSessionId },
                  }),
                ),
      };
    }),
}));

const threadId = ThreadId.makeUnsafe("thread-droid-resume");

const runWithAdapter = <A, E>(
  body: (adapter: typeof DroidAdapter.Service) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* DroidAdapter;
      return yield* body(adapter).pipe(Effect.ensuring(Effect.ignore(adapter.stopAll())));
    }).pipe(
      Effect.provide(
        makeDroidAdapterLive().pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "droid-resume-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

const startSession = (adapter: typeof DroidAdapter.Service, resumeCursor?: unknown) =>
  adapter.startSession({
    provider: "droid",
    threadId,
    runtimeMode: "full-access",
    cwd: process.cwd(),
    // ProviderService treats a null cursor as no native continuation.
    ...(resumeCursor !== undefined && resumeCursor !== null ? { resumeCursor } : {}),
  });

// The prompt runs on its own fiber, so wait for it to reach Droid.
const awaitResumeCursor = (adapter: typeof DroidAdapter.Service) =>
  adapter.listSessions().pipe(
    Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)),
    Effect.flatMap((session) =>
      session?.resumeCursor ? Effect.succeed(session.resumeCursor) : Effect.fail("not yet"),
    ),
    Effect.retry(Schedule.addDelay(Schedule.recurs(400), () => Effect.succeed("5 millis"))),
    Effect.orDie,
  );

describe("Droid resume cursor", () => {
  beforeEach(() => {
    droid.sessions.clear();
    droid.spawns.length = 0;
    droid.nextSessionNumber = 0;
    droid.promptHeldUntil = undefined;
  });

  it("does not leave a cursor Droid refuses when a handoff session stops before its first prompt", async () => {
    const { first, second, sessionsAfterStop } = await runWithAdapter((adapter) =>
      Effect.gen(function* () {
        // A same-thread handoff starts the target session eagerly, without a prompt.
        const first = yield* startSession(adapter);
        // Restarting it before the first send (a model change, idle stop, app quit)
        // closes the empty session, which Droid deletes.
        yield* adapter.stopSession(threadId);
        const sessionsAfterStop = [...droid.sessions.keys()];
        // The next start receives whatever cursor the stopped session advertised.
        const second = yield* startSession(adapter, first.resumeCursor).pipe(Effect.result);
        return { first, second, sessionsAfterStop };
      }),
    );

    expect(sessionsAfterStop).toEqual([]);
    expect(first.resumeCursor).toBeNull();
    expect(second._tag).toBe("Success");
    expect(droid.spawns).toEqual([{}, {}]);
  });

  it("advertises the cursor once a prompt reaches Droid, and that session resumes natively", async () => {
    const { cursor, resumed } = await runWithAdapter((adapter) =>
      Effect.gen(function* () {
        yield* startSession(adapter);
        yield* adapter.sendTurn({ threadId, input: "first message" });
        const cursor = yield* awaitResumeCursor(adapter);
        yield* adapter.stopSession(threadId);
        const resumed = yield* startSession(adapter, cursor);
        return { cursor, resumed };
      }),
    );

    expect(cursor).toEqual({ schemaVersion: 1, sessionId: "droid-session-1" });
    expect(droid.spawns).toEqual([{}, { resumeSessionId: "droid-session-1" }]);
    expect(resumed.resumeCursor).toEqual(cursor);
  });

  // ProviderService persists a session's live cursor to the thread's binding when it
  // sees thread.started, so the first prompt must publish one while its turn is open.
  it("publishes thread.started with the resumable cursor while the first turn is still running", async () => {
    let releasePrompt!: () => void;
    droid.promptHeldUntil = new Promise((resolve) => {
      releasePrompt = resolve;
    });
    const { startedThreadIds, cursorAtEvent, sessionAtEvent, droidHadPrompt } =
      await runWithAdapter((adapter) =>
        Effect.gen(function* () {
          yield* startSession(adapter);
          const threadStartedFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "thread.started"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* adapter.sendTurn({ threadId, input: "first message" });
          const threadStarted = Array.from(
            yield* Fiber.join(threadStartedFiber).pipe(Effect.timeout("2 seconds")),
          );
          // thread.started is published as the prompt is dispatched; wait until the
          // held prompt has reached Droid, so the turn is provably still running.
          const droidHadPrompt = yield* Effect.suspend(() =>
            droid.sessions.get("droid-session-1")?.hasRealContent === true
              ? Effect.succeed(true)
              : Effect.fail("not yet"),
          ).pipe(
            Effect.retry(Schedule.addDelay(Schedule.recurs(400), () => Effect.succeed("5 millis"))),
            Effect.orElseSucceed(() => false),
          );
          const sessionAtEvent = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          );
          releasePrompt();
          return {
            startedThreadIds: threadStarted.map((event) =>
              event.type === "thread.started" ? event.payload.providerThreadId : undefined,
            ),
            cursorAtEvent: sessionAtEvent?.resumeCursor,
            sessionAtEvent,
            droidHadPrompt,
          };
        }),
      );

    expect(startedThreadIds).toEqual(["droid-session-1"]);
    expect(cursorAtEvent).toEqual({ schemaVersion: 1, sessionId: "droid-session-1" });
    expect(sessionAtEvent?.activeTurnId).toBeDefined();
    expect(droidHadPrompt).toBe(true);
  });

  it("reports a session Droid no longer has as resume-state-unavailable", async () => {
    const { result, live } = await runWithAdapter((adapter) =>
      Effect.gen(function* () {
        const result = yield* startSession(adapter, {
          schemaVersion: 1,
          sessionId: "deleted-draft-session",
        }).pipe(Effect.result);
        const live = yield* adapter.hasSession(threadId);
        return { result, live };
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(ProviderAdapterProcessError);
      expect(result.failure).toMatchObject({ reason: "resume-state-unavailable" });
    }
    expect(live).toBe(false);
    expect(droid.spawns).toEqual([{ resumeSessionId: "deleted-draft-session" }]);
  });
});
