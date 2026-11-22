import "../../index.css";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";

function Composer({ layout }: { layout: "row" | "block" }) {
  return (
    <div
      data-testid="shell"
      className={COMPOSER_INPUT_SHELL_CLASS_NAME}
      data-composer-layout={layout === "row" ? "row" : undefined}
    >
      <div
        data-testid="surface"
        data-chat-composer-surface=""
        className={COMPOSER_INPUT_SURFACE_CLASS_NAME}
      >
        draft
      </div>
    </div>
  );
}

function cornerShape(element: Element): string {
  return getComputedStyle(element).getPropertyValue("corner-top-left-shape");
}

describe("embedded composer corners", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-synara-embed");
  });

  // lattice-writer/lattice#1227: WebKit on macOS 27.3 painted the squircle full box as
  // nothing, so the embed keeps the pill's round corners on the full box too.
  it.each(["row", "block"] as const)("keeps round corners in the %s layout", async (layout) => {
    if (!CSS.supports("corner-shape: squircle")) return;
    document.documentElement.setAttribute("data-synara-embed", "true");
    const screen = await render(<Composer layout={layout} />);
    for (const id of ["shell", "surface"]) {
      const element = screen.getByTestId(id).element();
      expect(cornerShape(element)).toMatch(/^(round|superellipse\(1\))$/);
    }
  });

  it("keeps squircle corners on the standalone full box", async () => {
    if (!CSS.supports("corner-shape: squircle")) return;
    const screen = await render(<Composer layout="block" />);
    expect(cornerShape(screen.getByTestId("surface").element())).not.toMatch(
      /^(round|superellipse\(1\))$/,
    );
  });
});
