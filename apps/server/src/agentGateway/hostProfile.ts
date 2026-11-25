import { Effect } from "effect";

import type { McpToolCallResult } from "./protocol.ts";
import type { ToolEntry } from "./toolRuntime.ts";

export type AgentHostProfileId = "synara" | "lattice";

export interface AgentHostProfile {
  readonly id: AgentHostProfileId;
  readonly displayName: string;
  readonly contextTag: string;
  readonly mcpServerName: string;
  readonly mcpServerTitle: string;
  readonly browserToolsEnabled: boolean;
}

const SYNARA_HOST_PROFILE: AgentHostProfile = {
  id: "synara",
  displayName: "Synara",
  contextTag: "synara_host_context",
  mcpServerName: "synara",
  mcpServerTitle: "Synara App Control",
  browserToolsEnabled: true,
};

const LATTICE_HOST_PROFILE: AgentHostProfile = {
  id: "lattice",
  displayName: "Lattice",
  contextTag: "lattice_host_context",
  mcpServerName: "lattice",
  mcpServerTitle: "Lattice Tools",
  browserToolsEnabled: false,
};

export function resolveAgentHostProfile(
  value = process.env.AGENT_HOST_PROFILE ?? process.env.SYNARA_HOST_PROFILE,
): AgentHostProfile {
  return value?.trim().toLowerCase() === "lattice" ? LATTICE_HOST_PROFILE : SYNARA_HOST_PROFILE;
}

export const ACTIVE_AGENT_HOST_PROFILE = resolveAgentHostProfile();

/** The three tools that mutate a bibliography through Lattice's trusted broker. */
export const LATTICE_BIBLIOGRAPHY_TOOL_NAMES = [
  "cite",
  "upgrade_bibliography",
  "remove_reference",
] as const;
export type LatticeBibliographyToolName = (typeof LATTICE_BIBLIOGRAPHY_TOOL_NAMES)[number];

/**
 * How the writer let the agent change bibliographies in this sidecar. Lattice
 * decides both facts when it starts the sidecar (Settings → Agent): the
 * `.bib` write block it applies is the host's, so this only tells the model
 * the truth about which tools exist and whether file edits may touch a `.bib`.
 */
export interface LatticeBibliographyAccess {
  /** Bibliography tools withheld from the model. */
  readonly disabledTools: ReadonlySet<LatticeBibliographyToolName>;
  /** The model's own file tools may edit `.bib` files. */
  readonly directBibEdit: boolean;
}

/**
 * `LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS` is a comma-separated subset of the
 * tool names; an unknown name is ignored rather than widening anything.
 * `LATTICE_DIRECT_BIB_EDIT=1` is the only value that allows direct edits.
 */
export function resolveLatticeBibliographyAccess(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LatticeBibliographyAccess {
  const named = (env.LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim());
  return {
    disabledTools: new Set(LATTICE_BIBLIOGRAPHY_TOOL_NAMES.filter((tool) => named.includes(tool))),
    directBibEdit: env.LATTICE_DIRECT_BIB_EDIT?.trim() === "1",
  };
}

export const ACTIVE_LATTICE_BIBLIOGRAPHY_ACCESS = resolveLatticeBibliographyAccess();

export function isThreadControlWithinActiveHostBoundary(
  callerProjectId: string | undefined,
  targetProjectId: string,
): boolean {
  return ACTIVE_AGENT_HOST_PROFILE.id !== "lattice" || callerProjectId === targetProjectId;
}

const LATTICE_TOOL_ALIASES = new Map<string, string>([
  ["synara_context", "context"],
  ["synara_capabilities", "agent_capabilities"],
  ["synara_list_projects", "list_projects"],
  ["synara_list_threads", "list_tasks"],
  ["synara_read_thread", "read_task"],
  ["synara_read_thread_activity", "read_task_activity"],
  ["synara_read_thread_events", "read_task_events"],
  ["synara_read_thread_runtime_events", "read_task_runtime_events"],
  ["synara_diagnose_thread", "diagnose_task"],
  ["synara_wait_for_threads", "wait_for_tasks"],
  ["synara_create_threads", "create_tasks"],
  ["synara_create_thread", "create_task"],
  ["synara_send_message", "send_message_to_task"],
  ["synara_interrupt_thread", "interrupt_task"],
  ["synara_set_thread_title", "set_task_title"],
  ["synara_set_thread_archived", "set_task_archived"],
  ["synara_set_thread_goal", "set_task_goal"],
  ["synara_create_automation", "create_automation"],
  ["synara_list_automations", "list_automations"],
  ["synara_view_automation", "view_automation"],
  ["synara_update_automation_memory", "update_automation_memory"],
  ["synara_update_automation", "update_automation"],
  ["synara_cancel_automation", "cancel_automation"],
  ["synara_report_automation_result", "report_automation_result"],
  ["synara_show_visual", "show_visual"],
]);

const LATTICE_NATIVE_TOOL_NAMES = new Set([
  "search_literature",
  "list_papers",
  "search_library",
  "fetch_paper",
  "cite",
  "fetch_web_reference",
  "upgrade_bibliography",
  "remove_reference",
  "list_canvas_shapes",
  "create_canvas_shapes",
  "update_canvas_shapes",
  "delete_canvas_shapes",
  "spreadsheet_read",
  "spreadsheet_batch_update",
  "create_project_document",
  "read_editor_comments",
  "preview_presentation_page",
  "preview_latex_figure",
  "device_list",
  "device_boot",
  "device_configure",
  "device_install",
  "device_launch",
  "device_open_url",
  "device_tap",
  "device_swipe",
  "device_type",
  "device_press_button",
  "device_screenshot",
  "device_describe_ui",
  "device_scroll_to_element",
  "device_wait",
  "device_logs",
]);

export function replaceModelVisibleHostBranding(value: string): string {
  if (ACTIVE_AGENT_HOST_PROFILE.id !== "lattice") return value;
  return value.replace(/synara/gi, (match) => {
    if (match === match.toUpperCase()) return "LATTICE";
    return match.startsWith("S") ? "Lattice" : "lattice";
  });
}

function replaceModelVisibleToolAliases(value: string): string {
  if (ACTIVE_AGENT_HOST_PROFILE.id !== "lattice") return value;
  let next = value;
  for (const [upstreamName, latticeName] of LATTICE_TOOL_ALIASES) {
    next = next.replaceAll(upstreamName, latticeName);
  }
  return replaceModelVisibleHostBranding(next);
}

function replaceStructuredBranding(value: unknown): unknown {
  if (typeof value === "string") return replaceModelVisibleToolAliases(value);
  if (Array.isArray(value)) return value.map(replaceStructuredBranding);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      replaceModelVisibleToolAliases(key),
      replaceStructuredBranding(nested),
    ]),
  );
}

function adaptToolResult(result: McpToolCallResult): McpToolCallResult {
  if (ACTIVE_AGENT_HOST_PROFILE.id !== "lattice") return result;
  return {
    ...result,
    content: result.content.map((part) =>
      part.type === "text" ? { ...part, text: replaceModelVisibleToolAliases(part.text) } : part,
    ),
    ...(result.structuredContent === undefined
      ? {}
      : {
          structuredContent: replaceStructuredBranding(result.structuredContent) as Record<
            string,
            unknown
          >,
        }),
  };
}

/**
 * Keep upstream tool implementations intact and adapt only their model-facing
 * catalog. Lattice exposes task coordination, automations, and the device pane;
 * browser control remains unavailable because the embedded runtime has no
 * Electron browser surface to drive.
 */
export function adaptToolsForActiveHost(
  tools: ReadonlyArray<ToolEntry>,
  bibliography: LatticeBibliographyAccess = ACTIVE_LATTICE_BIBLIOGRAPHY_ACCESS,
): ReadonlyArray<ToolEntry> {
  if (ACTIVE_AGENT_HOST_PROFILE.id !== "lattice") return tools;
  return tools.flatMap((tool) => {
    if (bibliography.disabledTools.has(tool.definition.name as LatticeBibliographyToolName)) {
      return [];
    }
    const alias = LATTICE_TOOL_ALIASES.get(tool.definition.name);
    if (!alias && !LATTICE_NATIVE_TOOL_NAMES.has(tool.definition.name)) return [];
    return [
      {
        ...tool,
        definition: {
          ...tool.definition,
          name: alias ?? tool.definition.name,
          description: replaceModelVisibleToolAliases(tool.definition.description),
          inputSchema: replaceStructuredBranding(
            tool.definition.inputSchema,
          ) as typeof tool.definition.inputSchema,
          ...(tool.definition.annotations === undefined
            ? {}
            : {
                annotations: {
                  ...tool.definition.annotations,
                  ...(tool.definition.annotations.title === undefined
                    ? {}
                    : {
                        title: replaceModelVisibleToolAliases(tool.definition.annotations.title),
                      }),
                },
              }),
        },
        handler: (args, context) => tool.handler(args, context).pipe(Effect.map(adaptToolResult)),
      },
    ];
  });
}
