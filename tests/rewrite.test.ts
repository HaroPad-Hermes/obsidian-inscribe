import { describe, it, expect } from "vitest";
import { buildRewriteMessages, REWRITE_PRESETS, REWRITE_SYSTEM_PROMPT } from "../src/completions/rewrite";

describe("buildRewriteMessages", () => {
    it("wraps the selection in markers with before/after context", () => {
        const [sys, user] = buildRewriteMessages({
            instruction: "Shorten",
            selection: "the middle part",
            before: "Start of note. ",
            after: " End of note.",
        });
        expect(sys.content).toBe(REWRITE_SYSTEM_PROMPT);
        expect(user.content).toContain("Instruction: Shorten");
        expect(user.content).toContain("<context_before>\nStart of note. \n</context_before>");
        expect(user.content).toContain("<selected>\nthe middle part\n</selected>");
        expect(user.content).toContain("<context_after>\n End of note.\n</context_after>");
    });

    it("emits empty context blocks when there is no surrounding text", () => {
        const [, user] = buildRewriteMessages({
            instruction: "Rephrase",
            selection: "only text",
            before: "",
            after: "",
        });
        expect(user.content).toContain("<context_before></context_before>");
        expect(user.content).toContain("<context_after></context_after>");
    });

    it("caps the context at 8000 chars per side", () => {
        const long = "x".repeat(20000);
        const [, user] = buildRewriteMessages({
            instruction: "X",
            selection: "sel",
            before: long,
            after: long,
        });
        const before = user.content.match(/<context_before>\n([\s\S]*?)\n<\/context_before>/)?.[1] ?? "";
        expect(before.length).toBe(8000);
        const after = user.content.match(/<context_after>\n([\s\S]*?)\n<\/context_after>/)?.[1] ?? "";
        expect(after.length).toBe(8000);
    });
});

describe("REWRITE_PRESETS", () => {
    it("covers the operations users expect", () => {
        const ids = REWRITE_PRESETS.map((p) => p.id);
        expect(ids).toEqual(expect.arrayContaining(["rephrase", "shorten", "expand", "formal", "grammar", "latex"]));
    });
    it("every preset has a non-empty instruction", () => {
        for (const p of REWRITE_PRESETS) {
            expect(p.instruction.length, p.id).toBeGreaterThan(10);
        }
    });
});
