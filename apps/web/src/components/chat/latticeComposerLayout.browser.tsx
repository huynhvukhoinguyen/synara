// Lattice keeps its Agent panel at least as wide as the composer reports it needs
// (`synara:layout-metrics`). After a provider handoff the composer shows a note capsule
// above its box, and the capsule shares the box's `.chat-composer-surface` look. The
// report measured the send button against that capsule, so it asked for the frame's
// width plus the gap, and the panel could only ever grow.
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SYNARA_LAYOUT_METRICS } from "../../embedMode";
import { RefreshCwIcon } from "../../lib/icons";
import { ChatComposerFooter } from "./ChatComposerFooter";
import { ComposerCapsuleRow } from "./ComposerCapsule";
import { ComposerTipRow } from "./ComposerTipRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";
import { observeLatticeComposerLayout } from "./latticeComposerLayout";

const EMBED_MODE_STORAGE_KEY = "synara.poc.embed-mode";
const noop = () => {};

function EmbeddedBlockComposer({ withHandoffNote }: { withHandoffNote: boolean }) {
  return (
    <form data-chat-composer-form="true" className="mx-3 flex flex-col">
      <ComposerCapsuleRow>
        {withHandoffNote ? (
          <ComposerTipRow
            icon={<RefreshCwIcon aria-hidden="true" className="size-3.5" />}
            message="聊天上下文会消耗新提供商的额度。"
            onDismiss={noop}
            testId="composer-claude-model-switch-note"
          />
        ) : null}
      </ComposerCapsuleRow>
      <div data-chat-composer-surface="" className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
        <div className="min-h-12 px-3 pt-2">line one</div>
        <ChatComposerFooter
          layout="block"
          isComposerFooterCompact={false}
          leadingControls={<button type="button" aria-label="Add" className="size-7" />}
          composerPickerControls={null}
          contextMeter={null}
          interactionMode="default"
          resetInteractionMode={noop}
          sidebarAction={null}
          voice={{
            enabled: false,
            recording: false,
            starting: false,
            waitingForAudio: false,
            transcribing: false,
            durationLabel: "",
            waveformLevels: [],
            onCancel: noop,
            onSubmit: noop,
            onToggle: noop,
          }}
          pendingInput={null}
          submission={{
            phase: "ready",
            busy: false,
            connecting: false,
            expired: false,
            preparingImages: false,
            preparingWorktree: false,
            hasContent: true,
            hasPendingUserInputs: false,
            showPlanFollowUp: false,
            hasPrompt: true,
            onInterrupt: noop,
            onImplementInNewThread: noop,
          }}
        />
      </div>
    </form>
  );
}

async function nextFrames(count = 3) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }
}

describe("observeLatticeComposerLayout", () => {
  let reported: number[] = [];
  let stopObserving: (() => void) | undefined;
  let unmount: (() => void | Promise<void>) | undefined;

  beforeEach(() => {
    reported = [];
    sessionStorage.setItem(
      EMBED_MODE_STORAGE_KEY,
      JSON.stringify({
        workspaceRoot: "/work/alpha",
        theme: "light",
        surface: "chrome",
        hostOrigin: window.location.origin,
        locale: "zh-CN",
      }),
    );
    const postMessage = window.parent.postMessage.bind(window.parent);
    vi.spyOn(window.parent, "postMessage").mockImplementation(((
      message: unknown,
      ...rest: unknown[]
    ) => {
      const data = message as { type?: unknown; minimumSidebarWidth?: unknown } | null;
      if (data?.type === SYNARA_LAYOUT_METRICS && typeof data.minimumSidebarWidth === "number") {
        reported.push(data.minimumSidebarWidth);
        return;
      }
      (postMessage as (...args: unknown[]) => void)(message, ...rest);
    }) as typeof window.parent.postMessage);
  });

  afterEach(async () => {
    stopObserving?.();
    stopObserving = undefined;
    await unmount?.();
    unmount = undefined;
    vi.restoreAllMocks();
    sessionStorage.removeItem(EMBED_MODE_STORAGE_KEY);
  });

  async function mount(withHandoffNote: boolean) {
    await page.viewport(600, 800);
    const screen = await render(<EmbeddedBlockComposer withHandoffNote={withHandoffNote} />);
    unmount = () => screen.unmount();
    const form = document.querySelector<HTMLFormElement>('[data-chat-composer-form="true"]');
    stopObserving = observeLatticeComposerLayout(form, false);
    await nextFrames();
  }

  async function reportAt(width: number): Promise<number> {
    await page.viewport(width, 800);
    await vi.waitFor(() => expect(window.innerWidth).toBe(width));
    await nextFrames();
    const latest = reported.at(-1);
    expect(latest, "the composer reported no minimum width").toBeTypeOf("number");
    return latest!;
  }

  it("reports the same minimum with the handoff note above the composer as without it", async () => {
    await mount(false);
    const withoutNote = await reportAt(600);
    stopObserving?.();
    stopObserving = undefined;
    await unmount?.();
    unmount = undefined;
    reported = [];

    await mount(true);
    expect(document.querySelector('[data-testid="composer-claude-model-switch-note"]')).not.toBe(
      null,
    );
    expect(await reportAt(600)).toBe(withoutNote);
    // Well under the frame: the send button already sits inside the composer box.
    expect(withoutNote).toBeLessThan(300);
  });

  it("does not raise the minimum each time the panel widens after a handoff", async () => {
    await mount(true);
    // Below the `sm` breakpoint throughout: the footer's spacing changes at 640px.
    const narrow = await reportAt(360);
    const wide = await reportAt(480);
    const wider = await reportAt(620);
    expect(wide).toBe(narrow);
    expect(wider).toBe(narrow);
    expect(narrow).toBeLessThan(360);
  });
});
