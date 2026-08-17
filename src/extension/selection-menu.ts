// Floating quick-action menu anchored to the text selection (plate-style AI
// selection bar): preset rewrite buttons + an "Ask AI anything…" input + a
// thinking toggle. On action it calls the injected runner; the caller decides
// what to do with the result (dispatch the inline diff).
//
// The menu is rendered through CM6's TOOLTIP system (the `showTooltip`
// facet) — the supported mechanism for floating UI anchored to a document
// position. The tooltip layer re-measures on scroll/resize and re-derives
// the anchor via the TooltipView `getCoords` hook, so the bar is glued to
// the document and scrolls with it natively; it is hidden automatically
// when the selection scrolls out of the editor and reappears when it
// scrolls back in. Raw DOM appended to .cm-content/.cm-scroller is not
// managed by CM6 and gets removed or pinned to the visible box — both were
// tried and failed before this rewrite.
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, showTooltip, tooltips } from "@codemirror/view";
import type { Rect, Tooltip, TooltipView } from "@codemirror/view";
import { setIcon, setTooltip } from "obsidian";
import { REWRITE_PRESETS } from "src/completions/rewrite";
import { diffSessionState } from "./diff";
import type { SelectionMenuPlacement, SelectionMenuSide } from "src/settings/settings";

export interface SelectionMenuRunner {
    (instruction: string, thinking: boolean): Promise<boolean>;
}

// Resolve the menu's horizontal anchor:
//  - "smart":    single-line selections hug the leftmost highlighted
//                character; multi-line selections (different visual lines —
//                hard newline OR soft wrap) pin to the text field's left edge
//  - "centered": centered on the selection's midpoint
//  - "first":    always the leftmost highlighted character
export function resolveMenuLeft(
    mode: SelectionMenuPlacement,
    fromLeft: number,
    contentLeft: number,
    multiLine: boolean,
    midX: number,
    menuWidth: number,
    viewportWidth: number
): number {
    switch (mode) {
        case "centered":
            return Math.max(8, Math.min(midX - menuWidth / 2, viewportWidth - menuWidth - 8));
        case "first":
            return Math.max(8, fromLeft);
        case "smart":
        default:
            return multiLine ? contentLeft : Math.max(8, fromLeft);
    }
}

// Pure positioning: vertical placement on the chosen side of the selection
// ("below" the bottom edge, "above" the top edge), flipping to the other side
// when the menu would overflow the viewport; the left corner is already
// resolved by the caller, then — when pullIn is enabled — softly pulled in
// when it would stick out past the text field's right edge (0.5px left per
// 1px of overflow, rather than a hard clamp). Unit-testable.
export function computeMenuPosition(
    anchor: { left: number; top: number; bottom: number },
    menu: { width: number; height: number },
    viewport: { width: number; height: number },
    side: SelectionMenuSide,
    contentRight: number,
    pullIn: boolean
): { left: number; top: number } {
    let left = Math.max(8, anchor.left);
    if (pullIn) {
        const overflow = left + menu.width - contentRight;
        if (overflow > 0) {
            left = Math.max(8, left - overflow / 2);
        }
    }
    if (side === "above") {
        const above = anchor.top - menu.height - 6;
        if (above >= 8) return { left, top: above };
        // Would overflow the top — fall back below.
        const below = Math.min(anchor.bottom + 6, viewport.height - menu.height - 8);
        return { left, top: Math.max(8, below) };
    }
    const below = anchor.bottom + 6;
    const top = below + menu.height > viewport.height - 8 ? Math.max(8, anchor.top - menu.height - 6) : below;
    return { left, top };
}

const PRESET_ICONS: Record<string, string> = {
    rephrase: "wand-2",
    shorten: "minimize-2",
    expand: "maximize-2",
    formal: "graduation-cap",
    grammar: "spell-check",
    latex: "sigma",
};

// What the menu needs while it is open. The getters are stable references to
// the live settings (placement/side/pull-in are re-read on every measure, so
// setting changes apply immediately), and `plugin` carries the runner +
// thinking state.
interface SelectionMenuSpec {
    from: number;
    to: number;
    plugin: SelectionMenuHost;
    getPlacement: () => SelectionMenuPlacement;
    getSide: () => SelectionMenuSide;
    getPullIn: () => boolean;
    getGap: () => number;
}

interface SelectionMenuHost {
    thinking: boolean;
    currentMenu: HTMLElement | null;
    menuOpen: boolean;
    run(instruction: string, thinking: boolean): Promise<boolean>;
    hide(): void;
}

// The open menu, as a tooltip spec (null = hidden). Changing the value adds
// or removes the tooltip from the editor state.
const setSelectionMenuTooltip = StateEffect.define<SelectionMenuSpec | null>();

const selectionMenuTooltipField = StateField.define<SelectionMenuSpec | null>({
    create: () => null,
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(setSelectionMenuTooltip)) return e.value;
        }
        return value;
    },
    provide: (f) => showTooltip.from(f, (spec) => (spec ? tooltipFor(spec) : null)),
});

function tooltipFor(spec: SelectionMenuSpec): Tooltip {
    return {
        pos: spec.from,
        end: spec.to,
        above: spec.getSide() === "above",
        // strictSide defaults to false: the layer flips the bar to the other
        // side when the chosen one has no room, re-evaluating on every
        // scroll. (The vertical math in computeMenuPosition is kept for the
        // horizontal anchor + pull-in only.)
        create: (view) => buildMenuTooltipView(spec, view),
    };
}

function buildMenuTooltipView(spec: SelectionMenuSpec, view: EditorView): TooltipView {
    const host = spec.plugin;
    const menu = document.createElement("div");
    menu.className = "inscribe-selection-menu";
    menu.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection

    for (const preset of REWRITE_PRESETS) {
        const btn = document.createElement("button");
        btn.className = "inscribe-selection-btn";
        setIcon(btn, PRESET_ICONS[preset.id] ?? "sparkles");
        setTooltip(btn, preset.label, { placement: "top" });
        btn.addEventListener("click", () => {
            void host.run(preset.instruction, host.thinking).then((ok) => {
                if (ok) host.hide();
            });
        });
        menu.append(btn);
    }

    const divider = document.createElement("span");
    divider.className = "inscribe-selection-divider";
    menu.append(divider);

    const input = document.createElement("input");
    input.className = "inscribe-selection-input";
    input.type = "text";
    input.placeholder = "Ask AI anything…";
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            const value = input.value.trim();
            if (value) {
                void host.run(value, host.thinking).then((ok) => {
                    if (ok) host.hide();
                });
                input.value = "";
            }
        }
    });
    menu.append(input);
    menu.append(divider.cloneNode(true));
    const think = document.createElement("button");
    think.className = "inscribe-selection-btn";
    setIcon(think, "brain");
    think.classList.toggle("is-active", host.thinking);
    setTooltip(think, `Thinking: ${host.thinking ? "on" : "off"}`, { placement: "top" });
    think.addEventListener("click", () => {
        host.thinking = !host.thinking;
        think.classList.toggle("is-active", host.thinking);
        setTooltip(think, `Thinking: ${host.thinking ? "on" : "off"}`, { placement: "top" });
    });
    menu.append(think);

    host.currentMenu = menu;
    host.menuOpen = true;
    document.body.classList.add("inscribe-menu-open");

    return {
        dom: menu,
        // Vertical gap between the selection and the bar (live setting — the
        // layer reads `offset` on every measure, so changes apply without a
        // restart and on both the below and above sides).
        get offset() {
            return { x: 0, y: spec.getGap() };
        },
        // Never squish the bar to fit short panes.
        resize: false,
        // Called by the tooltip layer on every measure (scroll, resize,
        // geometry change): recompute the anchor from the CURRENT selection
        // geometry so the bar stays glued to the document. Placement runs in
        // the scroller's visible frame (clamps use the pane's real bounds);
        // the returned rect is in client coordinates — the layer converts it
        // into its own frame.
        getCoords: () => {
            const from = view.coordsAtPos(spec.from);
            // side=-1 for the end: coordsAtPos defaults to the element
            // AFTER the position, and at a line-wrap point that is the
            // first character of the NEXT line — a selection ending in the
            // line's final space would falsely read as multi-line. The
            // element before the position (the last selected character)
            // is on the correct line.
            const to = view.coordsAtPos(spec.to, -1);
            if (!from || !to) {
                // The layer's runtime handles a null anchor (hides the bar
                // until the selection scrolls back into measured range) even
                // though the public type only admits Rect.
                return null as unknown as Rect;
            }
            // Multi-line detection via geometry: start and end on different
            // visual lines (hard newline OR soft wrap) have different top
            // coordinates — a sliceDoc "\n" check would miss wrapped
            // paragraphs.
            const multiLine = Math.abs(to.top - from.top) > 1;
            const scroller = view.scrollDOM;
            const scrollerRect = scroller.getBoundingClientRect();
            const originX = scrollerRect.left + scroller.clientLeft;
            const originY = scrollerRect.top + scroller.clientTop;
            const contentRect = view.contentDOM.getBoundingClientRect();
            const width = menu.offsetWidth || 260;
            const height = menu.offsetHeight || 34;
            const left = resolveMenuLeft(
                spec.getPlacement(),
                from.left - originX,
                contentRect.left - originX,
                multiLine,
                (from.left + to.right) / 2 - originX,
                width,
                scroller.clientWidth
            );
            const { left: finalLeft } = computeMenuPosition(
                {
                    left,
                    top: Math.min(from.top, to.top) - originY,
                    bottom: Math.max(from.bottom, to.bottom) - originY,
                },
                { width, height },
                { width: scroller.clientWidth, height: scroller.clientHeight },
                spec.getSide(),
                contentRect.right - originX,
                spec.getPullIn()
            );
            return {
                left: finalLeft + originX,
                top: Math.min(from.top, to.top),
                bottom: Math.max(from.bottom, to.bottom),
                right: finalLeft + originX + width,
            };
        },
        destroy: () => {
            host.currentMenu = null;
            host.menuOpen = false;
            document.body.classList.remove("inscribe-menu-open");
        },
    };
}

export function selectionMenuPlugin(
    run: SelectionMenuRunner,
    getPlacement: () => SelectionMenuPlacement,
    getSide: () => SelectionMenuSide,
    getPullIn: () => boolean,
    getGap: () => number
) {
    return ViewPlugin.fromClass(
        class SelectionMenuView implements SelectionMenuHost {
            view: EditorView;
            currentMenu: HTMLElement | null = null;
            menuOpen = false;
            thinking = true;
            private refreshTimer: number | null = null;
            private readonly SHOW_DELAY_MS = 350;
            private onKeyDown = (e: KeyboardEvent) => {
                if (!this.menuOpen) return;
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    this.hide();
                }
            };
            private onMouseDown = (e: MouseEvent) => {
                if (this.menuOpen && this.currentMenu && !this.currentMenu.contains(e.target as Node)) {
                    this.hide();
                }
            };

            constructor(view: EditorView) {
                this.view = view;
                document.addEventListener("keydown", this.onKeyDown, true);
                document.addEventListener("mousedown", this.onMouseDown, true);
            }

            destroy() {
                if (this.refreshTimer !== null) {
                    window.clearTimeout(this.refreshTimer);
                    this.refreshTimer = null;
                }
                document.body.classList.remove("inscribe-menu-open");
                document.removeEventListener("keydown", this.onKeyDown, true);
                document.removeEventListener("mousedown", this.onMouseDown, true);
                // The tooltip layer removes the menu DOM itself on view
                // destruction; just drop our references.
                this.currentMenu = null;
                this.menuOpen = false;
            }

            update(update: ViewUpdate) {
                if (update.selectionSet || update.docChanged) {
                    const sel = update.state.selection.main;
                    if (sel.empty || sel.from === sel.to) {
                        // Collapse hides immediately — no lingering menu.
                        this.hide();
                        return;
                    }
                    // Show is debounced: while the user drags the selection
                    // the timer keeps resetting, so the menu pops up only
                    // once the selection has settled (and never follows the
                    // cursor).
                    this.scheduleShow();
                }
                // Scroll/resize need no handling here: the tooltip layer
                // re-measures and re-anchors the menu via getCoords().
            }

            private scheduleShow() {
                if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
                this.refreshTimer = window.setTimeout(() => {
                    this.refreshTimer = null;
                    this.show();
                }, this.SHOW_DELAY_MS);
            }

            private show() {
                const sel = this.view.state.selection.main;
                if (sel.empty || sel.from === sel.to) {
                    this.hide();
                    return;
                }
                const from = this.view.coordsAtPos(sel.from);
                const to = this.view.coordsAtPos(sel.to, -1);
                if (!from || !to) {
                    this.hide();
                    return;
                }
                this.view.dispatch({
                    effects: setSelectionMenuTooltip.of({
                        from: sel.from,
                        to: sel.to,
                        plugin: this,
                        getPlacement,
                        getSide,
                        getPullIn,
                        getGap,
                    }),
                });
            }

            hide() {
                if (this.refreshTimer !== null) {
                    window.clearTimeout(this.refreshTimer);
                    this.refreshTimer = null;
                }
                // Drop the references immediately so the decorations and
                // outside-click/escape handlers stop treating the bar as
                // open; the tooltip's destroy() callback repeats this when
                // the layer actually removes the DOM.
                document.body.classList.remove("inscribe-menu-open");
                this.currentMenu = null;
                this.menuOpen = false;
                // Dispatch may be triggered from inside update(); defer so
                // the transaction lands after the current cycle.
                queueMicrotask(() => {
                    if (this.view.state.field(selectionMenuTooltipField, false) !== null) {
                        this.view.dispatch({ effects: setSelectionMenuTooltip.of(null) });
                    }
                });
            }

            run(instruction: string, thinking: boolean): Promise<boolean> {
                return run(instruction, thinking);
            }
        },
        {
            // While the menu is open and the editor is unfocused (e.g. the
            // user clicked the input), draw our own selection highlight —
            // themes may hide the native one on blur, which is confusing.
            // Skipped while a diff session is active (it has its own
            // highlight).
            decorations: (plugin: { view: EditorView; menuOpen: boolean }): DecorationSet => {
                const v = plugin.view;
                if (v.hasFocus || !plugin.menuOpen) return Decoration.none;
                if (v.state.field(diffSessionState, false)) return Decoration.none;
                const sel = v.state.selection.main;
                if (sel.empty) return Decoration.none;
                return Decoration.set([
                    Decoration.mark({ class: "inscribe-menu-selection" }).range(sel.from, sel.to),
                ]);
            },
            provide: () => [
                selectionMenuTooltipField,
                // Clamp/flip the bar against the editor pane instead of the
                // whole window (the tooltip system's default space).
                tooltips({ tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect() }),
            ],
        }
    );
}
