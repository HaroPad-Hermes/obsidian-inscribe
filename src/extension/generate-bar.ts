// "Generate with AI": a compact prompt bar anchored AT the cursor (same
// tooltip mechanism as the selection menu), so the user sees exactly where
// the text will land. Enter streams the generation into an inline diff at
// the cursor as it arrives (first output within ~a second); Esc cancels.
//
// Streaming contract: the runner yields the accumulated text; the bar
// dispatches a growing DiffSession (throttled) so the preview renders
// incrementally. If the diff session disappears (user typed elsewhere,
// accepted/discarded, or started another edit), the stream is aborted.
import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, showTooltip, tooltips } from "@codemirror/view";
import type { Rect, Tooltip, TooltipView } from "@codemirror/view";
import { Notice, setIcon, setTooltip } from "obsidian";
import { diffSessionState, setDiffEffect } from "./diff";
import { normalizeListLineBreaks } from "src/completions/flow";

export interface GenerateStreamRunner {
    (instruction: string, thinking: boolean, signal: AbortSignal): AsyncGenerator<string>;
}

interface GenerateBarSpec {
    from: number;
    to: number;
    host: GenerateBarHost;
    runner: GenerateStreamRunner;
    getGap: () => number;
}

interface GenerateBarHost {
    thinking: boolean;
    streaming: boolean;
    close(): void;
    cancel(): void;
    // The tooltip closure installs its abort handle here when the bar
    // mounts, so the plugin-level cancel() can stop the running stream.
    setCancel(fn: (() => void) | null): void;
    // Registers the bar DOM so the plugin's outside-click handler can tell
    // clicks inside the bar apart from clicks elsewhere.
    setBar(el: HTMLElement | null): void;
}

const setGenerateBarTooltip = StateEffect.define<GenerateBarSpec | null>();

const generateBarTooltipField = StateField.define<GenerateBarSpec | null>({
    create: () => null,
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(setGenerateBarTooltip)) return e.value;
        }
        return value;
    },
    provide: (f) => showTooltip.from(f, (spec) => (spec ? tooltipFor(spec) : null)),
});

function tooltipFor(spec: GenerateBarSpec): Tooltip {
    return {
        pos: spec.from,
        end: spec.to,
        above: false,
        create: (view) => buildGenerateBarTooltipView(spec, view),
    };
}

function buildGenerateBarTooltipView(spec: GenerateBarSpec, view: EditorView): TooltipView {
    const host = spec.host;
    const bar = document.createElement("div");
    bar.className = "inscribe-generate-bar";
    bar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor

    const input = document.createElement("input");
    input.className = "inscribe-generate-input";
    input.type = "text";
    input.placeholder = "Describe what to write…";
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            const value = input.value.trim();
            if (value) void start(value);
        } else if (e.key === "Escape") {
            if (host.streaming) host.cancel();
            else host.close();
        }
    });
    bar.append(input);

    const status = document.createElement("span");
    status.className = "inscribe-generate-status";
    status.style.display = "none";
    bar.append(status);

    const think = document.createElement("button");
    think.className = "inscribe-selection-btn";
    setIcon(think, "brain");
    think.classList.toggle("is-active", host.thinking);
    setTooltip(think, `Thinking: ${host.thinking ? "on" : "off"}`, { placement: "top" });
    think.addEventListener("click", () => {
        if (host.streaming) return;
        host.thinking = !host.thinking;
        think.classList.toggle("is-active", host.thinking);
        setTooltip(think, `Thinking: ${host.thinking ? "on" : "off"}`, { placement: "top" });
    });
    bar.append(think);

    let abortController: AbortController | null = null;
    host.setCancel(() => abortController?.abort());
    host.setBar(bar);

    // Push the accumulated text into the diff session — unless the session
    // is gone or no longer ours (user typed, accepted, discarded, or started
    // another edit), in which case the stream must stop.
    const dispatchDiff = (text: string): boolean => {
        const active = view.state.field(diffSessionState, false);
        if (!active || active.from !== spec.from || active.to !== spec.to) {
            host.cancel();
            return false;
        }
        view.dispatch({
            effects: setDiffEffect.of({
                from: spec.from,
                to: spec.to,
                original: "",
                rewritten: normalizeListLineBreaks(text),
            }),
        });
        return true;
    };

    const start = async (instruction: string) => {
        if (host.streaming) return;
        host.streaming = true;
        input.disabled = true;
        think.disabled = true;
        status.style.display = "inline";
        status.textContent = "Thinking…";
        abortController = new AbortController();
        let acc = "";
        let firstChunk = true;
        try {
            const gen = spec.runner(instruction, host.thinking, abortController.signal);
            let lastFlush = 0;
            for await (const text of gen) {
                acc = text;
                if (firstChunk) {
                    firstChunk = false;
                    status.textContent = "Writing…";
                }
                // Throttle preview updates (~8/s) — the diff widget re-renders
                // markdown per dispatch, so per-token would be janky.
                const now = Date.now();
                if (now - lastFlush >= 120) {
                    lastFlush = now;
                    if (!dispatchDiff(acc)) return;
                }
            }
            if (acc) dispatchDiff(acc);
            if (!acc && !abortController.signal.aborted) {
                new Notice("Inscribe: the model returned nothing");
            }
        } catch (error) {
            // Abort = user cancelled (or the diff was dismissed); stay quiet.
            // The OpenAI client may surface the abort as a plain error, so
            // also check the signal state.
            if (abortController.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
                return;
            }
            console.error("Inscribe: generate failed", error);
            new Notice("Inscribe: generate failed — see console");
            view.dispatch({ effects: setDiffEffect.of(null) });
        } finally {
            host.streaming = false;
            host.close();
        }
    };

    return {
        dom: bar,
        // Vertical gap from the cursor line (reuses the selection-menu gap
        // setting — the layer reads `offset` on every measure).
        get offset() {
            return { x: 0, y: spec.getGap() };
        },
        // Never squish the bar to fit short panes.
        resize: false,
        // Anchor to the cursor line; the layer decides above/below and
        // re-anchors on scroll. Returns client coords (the layer converts).
        getCoords: () => {
            const from = view.coordsAtPos(spec.from);
            const to = view.coordsAtPos(spec.to, -1);
            if (!from) {
                // The layer's runtime handles a null anchor (hides the bar
                // until the cursor scrolls back into measured range).
                return null as unknown as Rect;
            }
            const width = bar.offsetWidth || 300;
            return {
                left: from.left,
                top: Math.min(from.top, to?.top ?? from.top),
                bottom: Math.max(from.bottom, to?.bottom ?? from.bottom),
                right: from.left + width,
            };
        },
        mount() {
            input.focus();
        },
        destroy: () => {
            abortController?.abort();
            host.streaming = false;
            host.setCancel(null);
            host.setBar(null);
        },
    };
}

export function generateBarPlugin(runner: GenerateStreamRunner, getGap: () => number) {
    return ViewPlugin.fromClass(
        class GenerateBarView implements GenerateBarHost {
            view: EditorView;
            thinking = true;
            streaming = false;
            private currentBar: HTMLElement | null = null;
            private cancelStream: (() => void) | null = null;
            private onKeyDown = (e: KeyboardEvent) => {
                if (e.key !== "Escape") return;
                const open = this.view.state.field(generateBarTooltipField, false) !== null;
                if (!open && !this.streaming) return;
                e.preventDefault();
                e.stopPropagation();
                if (this.streaming) this.cancelStream?.();
                this.close();
            };
            private onMouseDown = (e: MouseEvent) => {
                if (this.currentBar && !this.currentBar.contains(e.target as Node)) {
                    // Close the prompt bar on outside clicks; a running
                    // stream keeps going (the diff preview + Discard remain).
                    this.close();
                }
            };

            constructor(view: EditorView) {
                this.view = view;
                document.addEventListener("keydown", this.onKeyDown, true);
                document.addEventListener("mousedown", this.onMouseDown, true);
            }

            destroy() {
                document.removeEventListener("keydown", this.onKeyDown, true);
                document.removeEventListener("mousedown", this.onMouseDown, true);
            }

            // Open the bar at the current cursor/selection. Public entry
            // point used by the editor menu and the command palette.
            open() {
                const sel = this.view.state.selection.main;
                this.view.dispatch({
                    effects: setGenerateBarTooltip.of({
                        from: sel.from,
                        to: sel.to,
                        host: this,
                        runner,
                        getGap,
                    }),
                });
            }

            close() {
                if (this.view.state.field(generateBarTooltipField, false) !== null) {
                    this.view.dispatch({ effects: setGenerateBarTooltip.of(null) });
                }
            }

            // Cancel a running stream and remove its partial diff. The
            // tooltip closure installs the abort handle when the bar mounts.
            cancel() {
                this.cancelStream?.();
                if (this.view.state.field(diffSessionState, false)) {
                    this.view.dispatch({ effects: setDiffEffect.of(null) });
                }
                this.close();
            }

            setCancel(fn: (() => void) | null) {
                this.cancelStream = fn;
            }

            setBar(el: HTMLElement | null) {
                this.currentBar = el;
            }
        },
        {
            provide: () => [
                generateBarTooltipField,
                // Clamp/flip the bar against the editor pane (tooltip default
                // is the whole window).
                tooltips({ tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect() }),
            ],
        }
    );
}
