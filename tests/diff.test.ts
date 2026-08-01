import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { diffSessionState, setDiffEffect, DiffSession } from "../src/extension/diff";

const session: DiffSession = { from: 6, to: 11, original: "world", rewritten: "universe" };

function makeState(): EditorState {
    return EditorState.create({ doc: "Hello world!", extensions: [diffSessionState] });
}

describe("diffSessionState", () => {
    it("starts null", () => {
        expect(makeState().field(diffSessionState)).toBeNull();
    });

    it("setDiffEffect installs the session", () => {
        const state = makeState();
        const next = state.update({ effects: setDiffEffect.of(session) }).state;
        expect(next.field(diffSessionState)).toEqual(session);
    });

    it("setDiffEffect(null) clears without touching the document", () => {
        const state = makeState().update({ effects: setDiffEffect.of(session) }).state;
        const next = state.update({ effects: setDiffEffect.of(null) }).state;
        expect(next.field(diffSessionState)).toBeNull();
        expect(next.doc.toString()).toBe("Hello world!");
    });

    it("accept-style transaction: replace the range and clear the session", () => {
        const state = makeState().update({ effects: setDiffEffect.of(session) }).state;
        const next = state.update({
            changes: { from: session.from, to: session.to, insert: session.rewritten },
            effects: setDiffEffect.of(null),
            userEvent: "inscribe.diff.accept",
        }).state;
        expect(next.field(diffSessionState)).toBeNull();
        expect(next.doc.toString()).toBe("Hello universe!");
    });

    it("discard keeps the document unchanged", () => {
        const state = makeState().update({ effects: setDiffEffect.of(session) }).state;
        const next = state.update({ effects: setDiffEffect.of(null), userEvent: "inscribe.diff.discard" }).state;
        expect(next.field(diffSessionState)).toBeNull();
        expect(next.doc.toString()).toBe("Hello world!");
    });

    it("any other document change ends the diff", () => {
        const state = makeState().update({ effects: setDiffEffect.of(session) }).state;
        const next = state.update({ changes: { from: 0, insert: "X" } }).state;
        expect(next.field(diffSessionState)).toBeNull();
    });

    it("selection-only transactions keep the session alive", () => {
        const state = makeState().update({ effects: setDiffEffect.of(session) }).state;
        const next = state.update({ selection: { anchor: 0, head: 0 } }).state;
        expect(next.field(diffSessionState)).toEqual(session);
    });

    it("positions map correctly after a change outside the range (before clearing is impossible — any change clears)", () => {
        // Documented behavior: any doc change clears, so no position mapping
        // is needed for the diff. This test pins that contract.
        const state = makeState().update({ effects: setDiffEffect.of(session) }).state;
        const next = state.update({ changes: { from: 12, insert: "!" } }).state;
        expect(next.field(diffSessionState)).toBeNull();
    });
});
