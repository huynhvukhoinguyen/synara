// The handoff row names both models and their efforts on one line. In a narrow
// Agent panel that line cannot fit, so it wraps instead of shrinking both model
// names to nothing and running the effort labels past the row.
import "../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { setLanguagePreference } from "../../i18n";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import type { ProviderHandoffInfo } from "../../workLog";
import { ProviderHandoffDivider } from "./ProviderHandoffDivider";

const INFO: ProviderHandoffInfo = {
  status: "completed",
  sourceProvider: "claudeAgent",
  sourceModel: "claude-fable-5-2",
  targetProvider: "droid",
  targetModel: "claude-opus-4-8",
  sourceModelSelection: {
    provider: "claudeAgent",
    model: "claude-fable-5-2",
    options: { effort: "medium" },
  },
  targetModelSelection: {
    provider: "droid",
    model: "claude-opus-4-8",
    options: { reasoningEffort: "high" },
  } as ProviderHandoffInfo["targetModelSelection"],
  contextText: "Transferred context",
  failureDetail: null,
};

function modelLabels(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-provider-handoff-divider="true"] .truncate'),
  );
}

describe("ProviderHandoffDivider", () => {
  let unmount: (() => void | Promise<void>) | undefined;

  beforeEach(() => {
    setLanguagePreference("zh-CN");
  });

  afterEach(async () => {
    await unmount?.();
    unmount = undefined;
    setLanguagePreference("en");
  });

  for (const width of [220, 260, 600]) {
    it(`keeps both model names readable and inside the row at ${width}px`, async () => {
      await page.viewport(width, 600);
      // The divider reads app settings to name each account.
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
      const screen = await render(
        <QueryClientProvider client={client}>
          <div className="px-4">
            <ProviderHandoffDivider info={INFO} />
          </div>
        </QueryClientProvider>,
      );
      unmount = () => screen.unmount();
      await expect.element(page.getByText("上下文移交")).toBeVisible();
      const row = document.querySelector<HTMLElement>(
        '[data-provider-handoff-divider="true"] button',
      )!;
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const labels = modelLabels();
      expect(labels.map((label) => label.textContent)).toEqual([
        "Claude Fable 5.2",
        "Claude Opus 4.8",
      ]);
      for (const label of labels) {
        // Wrapping gives each model room for its name; only the narrowest panel
        // still ellipsizes the end of it.
        expect(label.getBoundingClientRect().width).toBeGreaterThan(80);
      }
    });
  }
});
