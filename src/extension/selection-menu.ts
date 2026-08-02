// Floating quick-action menu anchored to the text selection (plate-style AI
// selection bar): preset rewrite buttons + an "Ask AI anything…" input + a
// thinking toggle. On action it calls the injected runner; the caller decides
// what to do with the result (dispatch the inline diff).
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
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

export function selectionMenuPlugin(
    run: SelectionMenuRunner,
    getPlacement: () => SelectionMenuPlacement,
    getSide: () => SelectionMenuSide,
    getPullIn: () => boolean
) {
    return ViewPlugin.fromClass(
        class {            view: EditorView;
            menu: HTMLElement | null = null;
            thinking = true;
            private refreshTimer: number | null = null;
            private readonly SHOW_DELAY_MS = 350;
            private onKeyDown = (e: KeyboardEvent) => {
                if (!this.menu || this.menu.style.display === "none") return;
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    this.hide();
                }
            };
            private onMouseDown = (e: MouseEvent) => {
                if (this.menu && this.menu.style.display !== "none" && !this.menu.contains(e.target as Node)) {
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
                this.menu?.remove();
                this.menu = null;
            }

            update(update: ViewUpdate) {
                if (update.selectionSet || update.docChanged) {
                    const sel = update.state.selection.main;
                    if (sel.empty || sel.from === sel.to) {
                        // Collapse hides immediately — no lingering menu.
                        this.hide();
                        return;
                    }
                    // Show is debounced: while the user drags the selection the
                    // timer keeps resetting, so the menu pops up only once the
                    // selection has settled (and never follows the cursor).
                    this.scheduleShow();
                } else if (update.geometryChanged) {
                    // Scroll/resize: reposition an already-visible menu right
                    // away. coordsAtPos() is forbidden during the update cycle,
                    // so defer to a microtask.
                    if (this.menu && this.menu.style.display !== "none") {
                        queueMicrotask(() => this.refresh());
                    }
                }
            }

            private scheduleShow() {
                if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
                this.refreshTimer = window.setTimeout(() => {
                    this.refreshTimer = null;
                    this.refresh();
                }, this.SHOW_DELAY_MS);
            }

            private refresh() {
                const sel = this.view.state.selection.main;
                if (sel.empty || sel.from === sel.to) {
                    this.hide();
                    return;
                }
                const from = this.view.coordsAtPos(sel.from);
                // side=-1 for the end: coordsAtPos defaults to the element
                // AFTER the position, and at a line-wrap point that is the
                // first character of the NEXT line — a selection ending in the
                // line's final space would falsely read as multi-line. The
                // element before the position (the last selected character)
                // is on the correct line.
                const to = this.view.coordsAtPos(sel.to, -1);
                if (!from || !to) {
                    this.hide();
                    return;
                }
                // Multi-line detection via geometry: start and end on
                // different visual lines (hard newline OR soft wrap) have
                // different top coordinates — a sliceDoc "\n" check would miss
                // wrapped paragraphs.
                const multiLine = Math.abs(to.top - from.top) > 1;
                const contentRect = this.view.contentDOM.getBoundingClientRect();
                this.show({
                    fromLeft: from.left,
                    contentLeft: contentRect.left,
                    contentRight: contentRect.right,
                    multiLine,
                    midX: (from.left + to.right) / 2,
                    top: Math.min(from.top, to.top),
                    bottom: Math.max(from.bottom, to.bottom),
                });
            }

            private show(anchor: {
                fromLeft: number;
                contentLeft: number;
                contentRight: number;
                multiLine: boolean;
                midX: number;
                top: number;
                bottom: number;
            }) {
                if (!this.menu) this.build();
                const menu = this.menu!;
                menu.style.display = "flex";
                // Keep the selection highlight visible even when the editor
                // loses focus to the menu's input (Obsidian themes hide the
                // selection on blur). Removed in hide()/destroy().
                document.body.classList.add("inscribe-menu-open");
                const width = menu.offsetWidth || 260;
                const left = resolveMenuLeft(
                    getPlacement(),
                    anchor.fromLeft,
                    anchor.contentLeft,
                    anchor.multiLine,
                    anchor.midX,
                    width,
                    window.innerWidth
                );
                const { left: finalLeft, top } = computeMenuPosition(
                    { left, top: anchor.top, bottom: anchor.bottom },
                    { width, height: menu.offsetHeight || 34 },
                    { width: window.innerWidth, height: window.innerHeight },
                    getSide(),
                    anchor.contentRight,
                    getPullIn()
                );
                menu.style.left = `${finalLeft}px`;
                menu.style.top = `${top}px`;
            }

            private hide() {
                if (this.refreshTimer !== null) {
                    window.clearTimeout(this.refreshTimer);
                    this.refreshTimer = null;
                }
                document.body.classList.remove("inscribe-menu-open");
                if (this.menu) this.menu.style.display = "none";
            }

            private build() {
                const menu = document.createElement("div");
                menu.className = "inscribe-selection-menu";
                menu.style.display = "none";
                menu.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection

                for (const preset of REWRITE_PRESETS) {
                    const btn = document.createElement("button");
                    btn.className = "inscribe-selection-btn";
                    setIcon(btn, PRESET_ICONS[preset.id] ?? "sparkles");
                    setTooltip(btn, preset.label, { placement: "top" });
                    btn.addEventListener("click", () => {
                        void this.act(preset.instruction);
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
                            void this.act(value);
                            input.value = "";
                        }
                    }
                });
                menu.append(input);
                menu.append(divider.cloneNode(true));
                const think = document.createElement("button");
                think.className = "inscribe-selection-btn";
                setIcon(think, "brain");
                think.classList.toggle("is-active", this.thinking);
                setTooltip(think, `Thinking: ${this.thinking ? "on" : "off"}`, { placement: "top" });
                think.addEventListener("click", () => {
                    this.thinking = !this.thinking;
                    think.classList.toggle("is-active", this.thinking);
                    setTooltip(think, `Thinking: ${this.thinking ? "on" : "off"}`, { placement: "top" });
                });
                menu.append(think);

                document.body.append(menu);
                this.menu = menu;
            }

            private async act(instruction: string) {
                const ok = await run(instruction, this.thinking);
                if (ok) this.hide();
            }
        },
        {
            // While the menu is open and the editor is unfocused (e.g. the
            // user clicked the input), draw our own selection highlight —
            // themes may hide the native one on blur, which is confusing.
            // Skipped while a diff session is active (it has its own highlight).
            decorations: (plugin: { view: EditorView; menu: HTMLElement | null }): DecorationSet => {
                const v = plugin.view;
                if (v.hasFocus || !plugin.menu || plugin.menu.style.display === "none") return Decoration.none;
                if (v.state.field(diffSessionState, false)) return Decoration.none;
                const sel = v.state.selection.main;
                if (sel.empty) return Decoration.none;
                return Decoration.set([
                    Decoration.mark({ class: "inscribe-menu-selection" }).range(sel.from, sel.to),
                ]);
            },
        }
    );
}
