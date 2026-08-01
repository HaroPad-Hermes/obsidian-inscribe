import { describe, it, expect } from "vitest";
import { computeGhost } from "../src/completions/flow";

const SYS = "You are an AI autocomplete engine. Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing.";

// These tests assert the CODE's deterministic behavior given controlled AI
// responses: the ghost SHAPE per classification. Semantic correctness of the
// AI's answers is judged by the battery (scripts/battery.ts), not asserted here.

function flow(text: string, classify: string | null, cont: string | null) {
    return computeGhost(text, SYS, {
        classifyWord: async () => classify,
        continueText: async () => cont,
    });
}

describe("ghost shape per AI1 classification (code behavior)", () => {
    it("complete word + [Finished] → leading space", async () => {
        expect(await flow("Lorem", "[Finished]", "ipsum dolor")).toBe(" ipsum dolor");
    });
    it("incomplete word + suffix answer → attaches (no leading space)", async () => {
        expect(await flow("Lorem ipsum d", "ol", "olor sit")).toBe("olor sit");
    });
    it("incomplete word + full-word answer → attaches", async () => {
        expect(await flow("Lorem ips", "ipsum", "um dolor")).toBe("um dolor");
    });
    it("incomplete word + echo answer → attaches", async () => {
        expect(await flow("Lorem ipsum d", "d", "olor sit")).toBe("olor sit");
    });
    it("incomplete word + wrongly [Finished] → leading space (AI1's verdict is honored)", async () => {
        // The code follows AI1. Whether the verdict is SEMANTICALLY right is
        // judged in the battery, where AI1's real answer is visible.
        expect(await flow("Lorem ipsum do", "[Finished]", "lor sit")).toBe(" lor sit");
    });
    it("complete word + wrongly not-finished → conflict check adds the space (AI2 wins)", async () => {
        // AI1 says "em" for "Lorem" but the continuation starts a new word —
        // the suffix doesn't match → leading space (fixes "Loremipsum").
        expect(await flow("Lorem", "em", "ipsum dolor")).toBe(" ipsum dolor");
    });
    it("number prefix: AI1 suffix conflicts with a fresh continuation → leading space", async () => {
        // Live failure: "the year 202" -> AI1 "02", continuation "The world..."
        // Without the cross-check the ghost glued: "202The".
        expect(await flow("the year 202", "02", "The world had changed")).toBe(" The world had changed");
    });
    it("number prefix with lowercase new word → conflict still detected", async () => {
        expect(await flow("the year 202", "02", "was a good year")).toBe(" was a good year");
    });
    it("suffix matching the continuation → attaches (consistent verdict)", async () => {
        expect(await flow("Lorem ipsum d", "ol", "olor sit amet")).toBe("olor sit amet");
    });
    it("echo verdict with matching continuation → attaches", async () => {
        expect(await flow("Lorem ipsum d", "d", "olor sit amet")).toBe("olor sit amet");
    });
    it("trailing space → no added leading space", async () => {
        expect(await flow("Lorem ", "[Finished]", "ipsum dolor")).toBe("ipsum dolor");
    });
});

describe("ghost hygiene (code behavior)", () => {
    it("strips leading/trailing whitespace from the model output", async () => {
        expect(await flow("Lorem ", "[Finished]", "  ipsum  \n")).toBe("ipsum");
    });
    it("drops stuck markers", async () => {
        for (const c of ["0", "0.", "0 ", "0!"]) {
            expect(await flow("Lorem", "[Finished]", c)).toBeNull();
        }
    });
    it("drops empty output", async () => {
        expect(await flow("Lorem", "[Finished]", "")).toBeNull();
        expect(await flow("Lorem", "[Finished]", "   ")).toBeNull();
    });
    it("drops aborted requests", async () => {
        expect(await flow("Lorem", null, "ipsum")).toBeNull();
        expect(await flow("Lorem", "[Finished]", null)).toBeNull();
    });
    it("strips markdown from output, preserving math", async () => {
        expect(await flow("Lorem", "[Finished]", "**ipsum** $x=1$ and `code`")).toBe(" ipsum $x=1$ and code");
    });
});
