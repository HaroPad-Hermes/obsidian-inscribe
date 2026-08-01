import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import {
    getResetSession,
    initializeSession,
    advanceSession,
    invalidateSession,
    updateSessionFromEffect,
    updateSessionOnDocumentChange,
    updateSessionOnCursorDrift,
} from "../src/extension/session";

const doc = Text.of(["Lorem ipsum"]);
const session = () => initializeSession({ content: " ipsum dolor", document: doc, anchor: 5 });

describe("session — lifecycle", () => {
    it("reset session is empty", () => {
        expect(getResetSession()).toEqual({
            fullText: null, remainingText: null, baselineDocument: null, anchorPosition: null,
        });
    });
    it("initialize sets full/remaining text and anchor", () => {
        const s = session();
        expect(s.fullText).toBe(" ipsum dolor");
        expect(s.remainingText).toBe(" ipsum dolor");
        expect(s.anchorPosition).toBe(5);
    });
    it("updateSessionFromEffect with null content resets (accept-all clears)", () => {
        const s = updateSessionFromEffect({ content: null, document: null, anchor: null });
        expect(s.remainingText).toBeNull();
        expect(s.fullText).toBeNull();
    });
    it("advanceSession consumes text and shifts the anchor", () => {
        const s = advanceSession(session(), 1);
        expect(s.remainingText).toBe("ipsum dolor");
        expect(s.anchorPosition).toBe(6);
    });
    it("advanceSession to the end nulls remainingText", () => {
        // " ipsum dolor" is 12 chars (1 + 5 + 1 + 5)
        const s = advanceSession(session(), 12);
        expect(s.remainingText).toBeNull();
    });
    it("invalidateSession keeps fullText but clears remaining", () => {
        const s = invalidateSession(session());
        expect(s.fullText).toBe(" ipsum dolor");
        expect(s.remainingText).toBeNull();
        expect(s.anchorPosition).toBeNull();
    });
});

describe("session — document changes", () => {
    it("matching insertion at the anchor advances the session", () => {
        const s = session();
        const tx = { changes: { iterChanges: (fn: any) => fn(5, 5, 5, 5, Text.of([" "])) } } as any;
        const updated = updateSessionOnDocumentChange(s, tx);
        expect(updated.remainingText).toBe("ipsum dolor");
    });
    it("non-matching insertion at the anchor invalidates", () => {
        const s = session();
        const tx = { changes: { iterChanges: (fn: any) => fn(5, 5, 5, 5, Text.of(["X"])) } } as any;
        expect(updateSessionOnDocumentChange(s, tx).remainingText).toBeNull();
    });
    it("insertion away from the anchor invalidates", () => {
        const s = session();
        const tx = { changes: { iterChanges: (fn: any) => fn(0, 0, 0, 0, Text.of(["X"])) } } as any;
        expect(updateSessionOnDocumentChange(s, tx).remainingText).toBeNull();
    });
});

describe("session — cursor drift", () => {
    it("cursor at the anchor keeps the session", () => {
        const s = session();
        const tx = { state: { selection: { main: { head: 5 } } } } as any;
        expect(updateSessionOnCursorDrift(s, tx).remainingText).toBe(" ipsum dolor");
    });
    it("cursor away from the anchor invalidates", () => {
        const s = session();
        const tx = { state: { selection: { main: { head: 9 } } } } as any;
        expect(updateSessionOnCursorDrift(s, tx).remainingText).toBeNull();
    });
});
