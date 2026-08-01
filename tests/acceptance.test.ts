import { describe, it, expect } from "vitest";
import { computeGhost } from "../src/completions/flow";

const SYS = "You are an AI autocomplete engine. Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing.";

// These tests assert the CODE's deterministic behavior given controlled AI
// responses: the ghost SHAPE per the plausible-word check verdict. Semantic
// correctness of the AI's answers is judged by the battery, not asserted here.

function flow(text: string, plausible: boolean | null, cont: string | null) {
    return computeGhost(text, SYS, {
        continueText: async () => cont,
        isPlausibleWord: async () => plausible,
    });
}

describe("ghost shape per plausible-word check (code behavior)", () => {
    it("candidate not a word → leading space (complete word + new continuation)", async () => {
        expect(await flow("Lorem", false, "ipsum dolor")).toBe(" ipsum dolor");
    });
    it("candidate is a word → attaches (mid-word completion)", async () => {
        expect(await flow("Lorem i", true, "psum dolor")).toBe("psum dolor");
    });
    it("candidate is a word → attaches (do→dolor)", async () => {
        expect(await flow("Lorem ipsum do", true, "lor sit")).toBe("lor sit");
    });
    it("trailing space → no added leading space, check not consulted", async () => {
        let consulted = false;
        const g = await computeGhost("Lorem ", SYS, {
            continueText: async () => "ipsum dolor",
            isPlausibleWord: async () => { consulted = true; return false; },
        });
        expect(g).toBe("ipsum dolor");
        expect(consulted).toBe(false);
    });
    it("check aborted (null) + lowercase → attaches", async () => {
        expect(await flow("Lorem i", null, "psum dolor")).toBe("psum dolor");
    });
    it("check aborted (null) + capital → leading space", async () => {
        expect(await flow("the year 202", null, "The world")).toBe(" The world");
    });
});

describe("ghost hygiene (code behavior)", () => {
    it("strips leading/trailing whitespace from the model output", async () => {
        expect(await flow("Lorem ", false, "  ipsum  \n")).toBe("ipsum");
    });
    it("drops stuck markers", async () => {
        for (const c of ["0", "0.", "0 ", "0!"]) {
            expect(await flow("Lorem", false, c)).toBeNull();
        }
    });
    it("drops empty output", async () => {
        expect(await flow("Lorem", false, "")).toBeNull();
        expect(await flow("Lorem", false, "   ")).toBeNull();
    });
    it("drops aborted requests", async () => {
        expect(await flow("Lorem", false, null)).toBeNull();
    });
    it("strips markdown from output, preserving math", async () => {
        expect(await flow("Lorem", false, "**ipsum** $x=1$ and `code`")).toBe(" ipsum $x=1$ and code");
    });
});
