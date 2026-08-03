// Inline diff view for "edit selected text": when a diff session is active,
// the original selection is hidden and the rewritten text is shown in its
// place with Accept / Discard buttons (plate-style).
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";

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

    toDOM() {
        // INLINE element — a block element here makes CM6 treat the widget as
        // a block widget, which is ILLEGAL from a StateField decorations
        // provider ("Block decorations may not be specified via plugins") and
        // throws inside the view update, breaking the whole editor.
        const span = document.createElement("span");
        span.className = "inscribe-diff-new";
        span.textContent = this.text;
        return span;
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
        EditorView.decorations.from(field, (session) => {
            if (!session) return Decoration.none;
            return (view: EditorView): DecorationSet => {
                const decos: Array<import("@codemirror/state").Range<Decoration>> = [];
            // Per-line widgets: each line of the rewritten text renders at the
            // start of the corresponding original line. A single inline widget
            // cannot lay out across replaced lines (it squeezes/staggers), and
            // a block widget is illegal from a decorations provider — so one
            // inline widget per line is the legal way to show multi-line text.
            const fromLine = view.state.doc.lineAt(session.from);
            const toLine = view.state.doc.lineAt(session.to);
            const origLineCount = toLine.number - fromLine.number + 1;
            const newLines = session.rewritten.split("\n");
            for (let i = 0; i < origLineCount; i++) {
                const text = newLines[i];
                if (text === undefined) break; // fewer new lines than original lines
                const pos = i === 0 ? session.from : view.state.doc.line(fromLine.number + i).from;
                decos.push(Decoration.widget({ widget: new DiffTextWidget(text), side: -1 }).range(pos));
            }
            // Extra new lines beyond the original range: trailing widget.
            if (newLines.length > origLineCount) {
                const extra = newLines.slice(origLineCount).join("\n");
                if (extra) decos.push(Decoration.widget({ widget: new DiffTextWidget(extra), side: 1 }).range(session.to));
            }
            // Replace decorations cannot be zero-length (CM6 throws
            // "Invalid range"); generate sessions insert at the cursor
            // (from === to) with nothing to hide.
            if (session.to > session.from) {
                decos.push(Decoration.replace({ inclusive: false }).range(session.from, session.to));
            }
            decos.push(Decoration.widget({ widget: new DiffButtonsWidget(session), side: 1 }).range(session.to));
            // RangeSetBuilder requires ranges sorted by (from, startSide);
            // startSide exists at runtime but is untyped on Range.
            const sideOf = (r: { from: number; startSide?: number }) => r.startSide ?? 0;
            decos.sort((a, b) => a.from - b.from || sideOf(a) - sideOf(b));
            return Decoration.set(decos);
            };
        }),
});
