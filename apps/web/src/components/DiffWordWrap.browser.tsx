// FILE: DiffWordWrap.browser.tsx
// Purpose: Verifies diff word wrap in split and stacked views: long lines wrap to the
//          viewport, split rows stay aligned across both sides, and a wrapped line shows
//          its number once, on its first visual row.
// Layer: Browser UI test

import "../index.css";

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { getRenderablePatch } from "~/lib/diffRendering";
import { DiffPanelFileList } from "./DiffPanelFileList";

const LONG_BEFORE = `where $\\mu_{\\mathrm{mix}}$ and $\\sigma_{\\mathrm{mix}}$ are the group mean and standard deviation ${"of the mixed reward ".repeat(12)}before.`;
const LONG_AFTER = `where $\\mu_{\\mathrm{mix}}$ and $\\sigma_{\\mathrm{mix}}$ are the group mean and standard deviation ${"of the mixed reward ".repeat(16)}after.`;

const PATCH = [
  "diff --git a/sec/3_method.tex b/sec/3_method.tex",
  "index 1111111..2222222 100644",
  "--- a/sec/3_method.tex",
  "+++ b/sec/3_method.tex",
  "@@ -1,4 +1,4 @@",
  " \\begin{equation}",
  "-" + LONG_BEFORE,
  "+" + LONG_AFTER,
  " \\end{equation}",
  " \\textbf{Per-reward normalization}",
  "",
].join("\n");

function patchFiles(): FileDiffMetadata[] {
  const renderable = getRenderablePatch(PATCH, "word-wrap-test");
  if (renderable?.kind !== "files") throw new Error("fixture patch did not parse");
  return [...renderable.files];
}

function diffShadowRoot(): ShadowRoot {
  const root = document.querySelector("diffs-container")?.shadowRoot;
  if (!root) throw new Error("diff not rendered");
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

type Box = { top: number; height: number };

function box(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { top: Math.round(rect.top), height: Math.round(rect.height) };
}

/** Each side's code row and line-number box, keyed by the row's new-or-old line number. */
function rows(side: "deletions" | "additions") {
  const code = diffShadowRoot().querySelector(`[data-${side}]`);
  if (!code) throw new Error(`no ${side} column`);
  return [...code.querySelectorAll("[data-line]")].map((line) => {
    const number = code.querySelector(
      `[data-column-number="${line.getAttribute("data-line")}"] [data-line-number-content]`,
    );
    if (!number) throw new Error("row without a line number");
    return { line: box(line), number: box(number) };
  });
}

async function renderDiff(diffRenderMode: "split" | "stacked", diffWordWrap: boolean) {
  await page.viewport(900, 700);
  await render(
    <div style={{ width: 800, height: 600 }}>
      <DiffPanelFileList
        renderableFiles={patchFiles()}
        resolvedTheme="light"
        diffRenderMode={diffRenderMode}
        diffWordWrap={diffWordWrap}
        workspaceRoot="/workspace"
        collapsedFiles={new Set()}
        onToggleFileCollapsed={vi.fn()}
      />
    </div>,
  );
  await vi.waitFor(
    () => {
      expect(diffShadowRoot().querySelector("[data-line]")).not.toBeNull();
    },
    { timeout: 20_000 },
  );
  return diffShadowRoot().querySelector("pre");
}

it("wraps split rows and keeps both sides aligned line by line", async () => {
  const pre = await renderDiff("split", true);
  expect(pre?.getAttribute("data-overflow")).toBe("wrap");

  const before = rows("deletions");
  const after = rows("additions");
  expect(before).toHaveLength(4);
  expect(after).toHaveLength(4);
  const lineHeight = before[0]!.line.height;

  for (const [index, row] of before.entries()) {
    expect(after[index]!.line).toEqual(row.line);
  }
  // The longer new line sets the row; the old side is padded to the same height.
  expect(after[1]!.line.height).toBeGreaterThan(lineHeight * 3);
  // A wrapped line shows its number once, on its first visual row.
  for (const side of [before, after]) {
    expect(side[1]!.number.top).toBe(side[1]!.line.top);
    expect(side[1]!.number.height).toBeLessThanOrEqual(lineHeight);
  }
});

it("keeps one visual row per line when word wrap is off", async () => {
  const pre = await renderDiff("split", false);
  expect(pre?.getAttribute("data-overflow")).toBe("scroll");

  const lineHeight = rows("deletions")[0]!.line.height;
  for (const row of [...rows("deletions"), ...rows("additions")]) {
    expect(row.line.height).toBe(lineHeight);
  }
});

it("wraps long lines in the stacked view", async () => {
  const pre = await renderDiff("stacked", true);
  expect(pre?.getAttribute("data-overflow")).toBe("wrap");

  const lines = [...diffShadowRoot().querySelectorAll("[data-line]")].map(box);
  const lineHeight = Math.min(...lines.map((line) => line.height));
  expect(Math.max(...lines.map((line) => line.height))).toBeGreaterThan(lineHeight * 3);
});
