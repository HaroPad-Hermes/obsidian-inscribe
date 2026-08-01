// Floating quick-action menu anchored to the text selection (plate-style AI
// selection bar): preset rewrite buttons + an "Ask AI anything…" input + a
// thinking toggle. On action it calls the injected runner; the caller decides
// what to do with the result (dispatch the inline diff).
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { setIcon, setTooltip } from "obsidian";
import { REWRITE_PRESETS } from "src/completions/rewrite";

export interface SelectionMenuRunner {
    (instruction: string, thinking: boolean): Promise<boolean>;
}

interface RectLike {
    left: number;
    top: number;
    bottom: number;
}

// Pure positioning: place the menu below the selection start, flipping above
// when it would overflow the viewport. Unit-testable.
export function computeMenuPosition(
    anchor: RectLike,
    menuHeight: number,
    viewport: { width: number; height: number }
): { left: number; top: number } {
    const left = Math.max(8, Math.min(anchor.left, viewport.width - 260));
    const below = anchor.bottom + 6;
    const top = below + menuHeight > viewport.height - 8 ? Math.max(8, anchor.top - menuHeight - 6) : below;
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

export function selectionMenuPlugin(run: SelectionMenuRunner) {
    return ViewPlugin.fromClass(
        class {
            view: EditorView;
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
                const coords = this.view.coordsAtPos(sel.from);
                if (!coords) {
                    this.hide();
                    return;
                }
                this.show(coords);
            }

            private show(anchor: RectLike) {
                if (!this.menu) this.build();
                const menu = this.menu!;
                menu.style.display = "flex";
                const { left, top } = computeMenuPosition(anchor, menu.offsetHeight || 34, {
                    width: window.innerWidth,
                    height: window.innerHeight,
                });
                menu.style.left = `${left}px`;
                menu.style.top = `${top}px`;
            }

            private hide() {
                if (this.refreshTimer !== null) {
                    window.clearTimeout(this.refreshTimer);
                    this.refreshTimer = null;
                }
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
        }
    );
}
