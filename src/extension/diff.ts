// Inline diff view for "edit selected text": when a diff session is active,
// the original selection is hidden and the rewritten text is shown in its
// place with Accept / Discard buttons (plate-style).
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { Component, MarkdownRenderer } from "obsidian";

export interface DiffSession {
    from: number;
    to: number;
    original: string;
    rewritten: string;
}

// Set a diff session (or null to clear it without touching the document).
export const setDiffEffect = StateEffect.define<DiffSession | null>();

// The rewritten text rendered as a widget (the replace decoration hides the
// original range; this widget shows the new text in its place).
class DiffTextWidget extends WidgetType {
    constructor(readonly text: string) {
        super();
    }

    // Reused for every widget instance — renderMarkdown registers cleanup on
    // the component; a long-lived one avoids unbounded growth.
    private static renderComponent = new Component();

    toDOM(view: EditorView) {
        // Render the preview with Obsidian's OWN markdown renderer — exact
        // theme styling for headings, lists, code, etc. (no CSS guesswork).
        // Single newlines become hard breaks so the preview matches Live
        // Preview's per-line layout (markdown would otherwise merge them).
        const container = document.createElement("div");
        container.className = "inscribe-diff-new";
        // renderMarkdown APPENDS into the element (it does not clear it), so
        // the plain-text fallback lives in its own child and is removed once
        // the real render lands — otherwise the raw text lingers above the
        // rendered ghost.
        const fallback = document.createElement("div");
        fallback.className = "inscribe-diff-fallback";
        fallback.textContent = this.text;
        container.appendChild(fallback);
        const display = this.text.replace(/([^\n])\n(?!\n)/g, "$1  \n");
        void MarkdownRenderer.renderMarkdown(display, container, "", DiffTextWidget.renderComponent)
            .then(() => {
                fallback.remove();
                view.requestMeasure();
            })
            .catch(() => {
                /* keep the plain-text fallback */
            });
        return container;
    }

    ignoreEvent() {
        return true;
    }
}

class DiffButtonsWidget extends WidgetType {
    constructor(readonly session: DiffSession) {
        super();
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("span");
        wrap.className = "inscribe-diff-buttons";
        wrap.contentEditable = "false";

        const accept = document.createElement("button");
        accept.className = "inscribe-diff-accept";
        accept.textContent = "Accept";
        accept.addEventListener("mousedown", (e) => {
            e.preventDefault();
            view.dispatch({
                changes: { from: this.session.from, to: this.session.to, insert: this.session.rewritten },
                effects: setDiffEffect.of(null),
                userEvent: "inscribe.diff.accept",
            });
            view.focus();
        });

        const discard = document.createElement("button");
        discard.className = "inscribe-diff-discard";
        discard.textContent = "Discard";
        discard.addEventListener("mousedown", (e) => {
            e.preventDefault();
            view.dispatch({
                effects: setDiffEffect.of(null),
                userEvent: "inscribe.diff.discard",
            });
            view.focus();
        });

        wrap.append(accept, discard);
        return wrap;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

export const diffSessionState = StateField.define<DiffSession | null>({
    create: () => null,
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(setDiffEffect)) return e.value;
        }
        // Any other document change (typing elsewhere, undo, etc.) ends the diff.
        if (tr.docChanged) return null;
        return value;
    },
    provide: (field) =>
        EditorView.decorations.from(field, (session): DecorationSet => {
            if (!session) return Decoration.none;
            const decos = [
                Decoration.widget({ widget: new DiffTextWidget(session.rewritten), side: -1 }).range(session.from),
                // Replace decorations cannot be zero-length (CM6 throws
                // "Invalid range"); generate sessions insert at the cursor
                // (from === to) with nothing to hide.
                ...(session.to > session.from
                    ? [Decoration.replace({ inclusive: false }).range(session.from, session.to)]
                    : []),
                Decoration.widget({ widget: new DiffButtonsWidget(session), side: 1 }).range(session.to),
            ];
            // RangeSetBuilder requires ranges sorted by (from, startSide);
            // startSide exists at runtime but is untyped on Range.
            const sideOf = (r: { from: number; startSide?: number }) => r.startSide ?? 0;
            decos.sort((a, b) => a.from - b.from || sideOf(a) - sideOf(b));
            return Decoration.set(decos);
        }),
});
