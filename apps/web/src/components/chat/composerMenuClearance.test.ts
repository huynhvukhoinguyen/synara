import { describe, expect, it } from "vitest";

import { COMPOSER_MENU_FLOATING_LAYER_GAP_PX, composerMenuLiftPx } from "./composerMenuClearance";

describe("composerMenuLiftPx", () => {
  it("lifts a menu that ends inside the floating layer to a gap above its top", () => {
    // The Lattice repro: the menu ended 24.5px below the context bar's top edge.
    expect(composerMenuLiftPx(1004.875, 980.375)).toBe(
      Math.ceil(1004.875 - 980.375 + COMPOSER_MENU_FLOATING_LAYER_GAP_PX),
    );
  });

  it("leaves a menu that already clears the layer in place", () => {
    expect(composerMenuLiftPx(900, 980)).toBe(0);
    expect(composerMenuLiftPx(980 - COMPOSER_MENU_FLOATING_LAYER_GAP_PX, 980)).toBe(0);
  });
});
