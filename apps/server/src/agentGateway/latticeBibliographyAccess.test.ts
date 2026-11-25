import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const tool = (name: string) => ({
  requiredCapability: "literature:write" as const,
  definition: { name, description: `The ${name} tool.`, inputSchema: { type: "object" as const } },
  handler: () => Effect.succeed({ content: [] }),
});

describe("Lattice bibliography access", () => {
  it("reads the writer's choice from the environment and ignores anything else", async () => {
    const { resolveLatticeBibliographyAccess } = await import("./hostProfile.ts");
    const none = resolveLatticeBibliographyAccess({});
    expect([...none.disabledTools]).toEqual([]);
    expect(none.directBibEdit).toBe(false);

    const some = resolveLatticeBibliographyAccess({
      LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS: " cite , remove_reference,write_file,",
      LATTICE_DIRECT_BIB_EDIT: "1",
    });
    expect([...some.disabledTools]).toEqual(["cite", "remove_reference"]);
    expect(some.directBibEdit).toBe(true);

    // Only the exact value "1" opens direct edits.
    for (const value of ["", "0", "true", "yes", "11"]) {
      expect(
        resolveLatticeBibliographyAccess({ LATTICE_DIRECT_BIB_EDIT: value }).directBibEdit,
      ).toBe(false);
    }
  });

  it("withholds only the disabled bibliography tools from the model's catalog", async () => {
    vi.stubEnv("AGENT_HOST_PROFILE", "lattice");
    const { adaptToolsForActiveHost, resolveLatticeBibliographyAccess } =
      await import("./hostProfile.ts");
    const catalog = [
      "cite",
      "upgrade_bibliography",
      "remove_reference",
      "search_library",
      "fetch_paper",
    ].map(tool);
    const names = (access: ReturnType<typeof resolveLatticeBibliographyAccess>) =>
      adaptToolsForActiveHost(catalog, access).map((entry) => entry.definition.name);

    expect(names(resolveLatticeBibliographyAccess({}))).toEqual([
      "cite",
      "upgrade_bibliography",
      "remove_reference",
      "search_library",
      "fetch_paper",
    ]);
    expect(
      names(resolveLatticeBibliographyAccess({ LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS: "cite" })),
    ).toEqual(["upgrade_bibliography", "remove_reference", "search_library", "fetch_paper"]);
    expect(
      names(
        resolveLatticeBibliographyAccess({
          LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS: "cite,upgrade_bibliography,remove_reference",
        }),
      ),
    ).toEqual(["search_library", "fetch_paper"]);
  });

  it("keeps the original rules byte for byte when nothing is changed", async () => {
    vi.stubEnv("AGENT_HOST_PROFILE", "lattice");
    const { renderSynaraHarnessPolicy } = await import("./harnessPolicy.ts");
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: true });
    expect(policy).toContain("Use cite to add or reuse a bibliography entry");
    expect(policy).toContain(
      "Never modify a .bib file directly, including through file-editing tools, patches, shell commands, scripts, or external bibliography utilities. Use cite, upgrade_bibliography, or remove_reference for every bibliography mutation.",
    );
    expect(policy).not.toContain("takes precedence over any project instruction file");
  });

  it("with cite withheld and direct edits allowed, drops the cite rules and says the setting wins over CLAUDE.md", async () => {
    vi.stubEnv("AGENT_HOST_PROFILE", "lattice");
    const { renderSynaraHarnessPolicy } = await import("./harnessPolicy.ts");
    const { resolveLatticeBibliographyAccess } = await import("./hostProfile.ts");
    const policy = renderSynaraHarnessPolicy({
      gatewayControlAvailable: true,
      bibliography: resolveLatticeBibliographyAccess({
        LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS: "cite,upgrade_bibliography,remove_reference",
        LATTICE_DIRECT_BIB_EDIT: "1",
      }),
    });
    expect(policy).not.toContain("Use cite to add");
    expect(policy).not.toContain("Never modify a .bib file directly");
    expect(policy).toContain("edit .bib files directly in this session");
    expect(policy).toContain("offers no Lattice bibliography tools");
    expect(policy).toContain("CLAUDE.md, AGENTS.md");
    expect(policy).toContain("follow this policy and edit the .bib directly");
  });

  it("names the tools that remain when only some are withheld", async () => {
    vi.stubEnv("AGENT_HOST_PROFILE", "lattice");
    const { renderSynaraHarnessPolicy } = await import("./harnessPolicy.ts");
    const { resolveLatticeBibliographyAccess } = await import("./hostProfile.ts");
    const render = (env: Record<string, string>, gatewayControlAvailable = true) =>
      renderSynaraHarnessPolicy({
        gatewayControlAvailable,
        bibliography: resolveLatticeBibliographyAccess(env),
      });

    const direct = render({
      LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS: "cite",
      LATTICE_DIRECT_BIB_EDIT: "1",
    });
    expect(direct).toContain("tools upgrade_bibliography, remove_reference remain available");
    expect(direct).not.toContain("Use cite to add");

    // Without a thread-scoped gateway no tool is reachable, so none is promised.
    expect(
      render({ LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS: "cite", LATTICE_DIRECT_BIB_EDIT: "1" }, false),
    ).toContain("offers no Lattice bibliography tools");

    // Direct edits stay forbidden unless allowed; a withheld tool is not a way around that.
    const guarded = render({ LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS: "cite" });
    expect(guarded).toContain("Use upgrade_bibliography, remove_reference for every");
    expect(guarded).toContain("cite is not available in this session");
    expect(guarded).toContain("If a project instruction file tells you to use cite");
    expect(guarded).not.toContain("edit .bib files directly");

    const sealed = render({
      LATTICE_DISABLED_BIBLIOGRAPHY_TOOLS: "cite,upgrade_bibliography,remove_reference",
    });
    expect(sealed).toContain("offers no bibliography tool, so do not change a bibliography");
  });
});
