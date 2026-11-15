// FILE: composerMenuClearance.ts
// Purpose: Keep the composer's upward menus (slash commands, mentions, extras) clear of
//   a layer that floats above the composer outside its measured layout.
// Layer: Chat composer layout helper
// Exports: composerMenuLiftPx (geometry), useComposerMenuClearance (measure)
//
// The menus open at `bottom-full` of the editor, inside the input shell's stacking
// context. Lattice's context bar floats above the composer as the shell's sibling,
// deliberately left out of the composer's measured height so a changing selection
// never moves the transcript. Anchored to the editor alone, a menu opened into the
// space that bar covers, and the bar painted over the menu's rows. The menu instead
// rises until its bottom edge sits a gap above the floating layer's top edge.

import { type RefObject, useLayoutEffect } from "react";

/** Space between a lifted menu and the floating layer below it; matches the menu's `mb-2`. */
export const COMPOSER_MENU_FLOATING_LAYER_GAP_PX = 8;

/**
 * How far a menu whose unlifted bottom edge is at `menuBottomPx` must rise so it ends
 * `gapPx` above a floating layer whose top edge is at `layerTopPx` (viewport pixels).
 */
export function composerMenuLiftPx(
  menuBottomPx: number,
  layerTopPx: number,
  gapPx = COMPOSER_MENU_FLOATING_LAYER_GAP_PX,
): number {
  return Math.max(0, Math.ceil(menuBottomPx - (layerTopPx - gapPx)));
}

/**
 * Keeps `menu` clear of `floatingLayer` while either moves: the layer resizes (a new
 * selection, its details expanding) or the composer's own content above the editor
 * grows, which `layoutContainerRef` must enclose. The lift goes straight onto the menu's
 * `translate`, so a resize re-measures against the lift actually painted and never
 * re-renders the chat view.
 */
export function useComposerMenuClearance({
  menu,
  floatingLayer,
  layoutContainerRef,
}: {
  menu: HTMLElement | null;
  floatingLayer: HTMLElement | null;
  layoutContainerRef: RefObject<HTMLElement | null>;
}): void {
  useLayoutEffect(() => {
    if (!menu || !floatingLayer) return;
    let appliedLiftPx = 0;
    const measure = () => {
      const menuBottomPx = menu.getBoundingClientRect().bottom + appliedLiftPx;
      appliedLiftPx = composerMenuLiftPx(menuBottomPx, floatingLayer.getBoundingClientRect().top);
      menu.style.translate = appliedLiftPx > 0 ? `0 -${appliedLiftPx}px` : "";
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(floatingLayer);
    const layoutContainer = layoutContainerRef.current;
    if (layoutContainer) observer?.observe(layoutContainer);
    return () => {
      observer?.disconnect();
      menu.style.translate = "";
    };
  }, [floatingLayer, layoutContainerRef, menu]);
}
