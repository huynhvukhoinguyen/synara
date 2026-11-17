import { describe, expect, it, vi } from "vitest";

import {
  parseGitHubItemUrl,
  resolveGitHubItemClickOpener,
  showLinkContextMenu,
  type ChatLinkActions,
} from "./linkContextMenu";

const host = vi.hoisted(() => ({
  readEmbedMode: vi.fn(),
  showMenu: vi.fn(),
  openExternalLink: vi.fn(),
}));
vi.mock("~/embedMode", () => ({ readEmbedMode: host.readEmbedMode }));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => ({ contextMenu: { show: host.showMenu } }) }));
vi.mock("~/lib/linkChips", () => ({ openExternalLink: host.openExternalLink }));

const PULL_REQUEST_URL = "https://github.com/acme/widgets/pull/41";
const ISSUE_URL = "https://github.com/acme/widgets/issues/42#issuecomment-1";

describe("parseGitHubItemUrl", () => {
  it("reads pull requests and issues", () => {
    expect(parseGitHubItemUrl(PULL_REQUEST_URL)).toEqual({
      kind: "pullRequest",
      repository: "acme/widgets",
      number: 41,
    });
    expect(parseGitHubItemUrl(ISSUE_URL)).toEqual({
      kind: "issue",
      repository: "acme/widgets",
      number: 42,
    });
  });

  it("ignores other URLs", () => {
    expect(parseGitHubItemUrl("https://github.com/acme/widgets")).toBeNull();
    expect(parseGitHubItemUrl("https://example.com/acme/widgets/pull/41")).toBeNull();
  });
});

describe("resolveGitHubItemClickOpener", () => {
  const actions = (githubLinkOpenTarget?: ChatLinkActions["githubLinkOpenTarget"]) =>
    ({
      openInBrowserPanel: vi.fn(),
      openGitHubItem: vi.fn(),
      githubLinkOpenTarget,
    }) satisfies ChatLinkActions;

  it("opens in the app by default", () => {
    const linkActions = actions();
    expect(resolveGitHubItemClickOpener(ISSUE_URL, linkActions)).toBe(linkActions.openGitHubItem);
  });

  it("follows the browser and external settings", () => {
    const browser = actions("browser");
    expect(resolveGitHubItemClickOpener(PULL_REQUEST_URL, browser)).toBe(
      browser.openInBrowserPanel,
    );
    expect(resolveGitHubItemClickOpener(PULL_REQUEST_URL, actions("external"))).toBeUndefined();
  });

  it("leaves other links and surfaces without actions external", () => {
    expect(resolveGitHubItemClickOpener("https://example.com", actions("app"))).toBeUndefined();
    expect(resolveGitHubItemClickOpener(PULL_REQUEST_URL, null)).toBeUndefined();
  });
});

describe("Lattice's link destination menu", () => {
  it("sends the selected override to the host with both choices available", async () => {
    const url = "https://example.com/private";
    host.readEmbedMode.mockReturnValue({ browserPanel: true });
    host.showMenu.mockResolvedValueOnce("open-in-browser").mockResolvedValueOnce("open-external");
    const input = { url, position: { x: 12, y: 10 }, actions: null };
    await showLinkContextMenu(input);
    await showLinkContextMenu(input);
    expect(host.showMenu).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "open-link-in",
          children: [
            expect.objectContaining({ id: "open-in-browser" }),
            expect.objectContaining({ id: "open-external" }),
          ],
        }),
      ]),
      input.position,
    );
    expect(host.openExternalLink).toHaveBeenNthCalledWith(1, url, "panel");
    expect(host.openExternalLink).toHaveBeenNthCalledWith(2, url, "external");
  });
});
