// Opens a real file-backed Synara home (engine, projections, event store) for
// tests that need a second, independent store, such as thread-home imports.

import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer, ManagedRuntime } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineLive } from "../Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../Layers/ProjectionSnapshotQuery.ts";

export const synaraHomeDbPath = (baseDir: string) =>
  nodePath.join(baseDir, "userdata", "state.sqlite");

export const makeSynaraHomeRuntime = (baseDir: string) =>
  ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(makeSqlitePersistenceLive(synaraHomeDbPath(baseDir))),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
