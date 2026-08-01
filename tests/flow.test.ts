import { describe, it, expect } from "vitest";
import { computeGhost, stripMarkdown, isStuckMarker, limitSentences, buildSystemPromptFrom } from "../src/completions/flow";

const SYS = "You are an AI autocomplete engine. Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing.";

function flow(text: string, classify: string | null, cont: string | null) {
    return computeGhost(text, SYS, {
        classifyWord: async () => classify,
        continueText: async () => cont,
    });
}

describe("computeGhost — spacing rules (code-decided)", () => {
    it("finished word, no trailing space → ghost gets a leading space", async () => {
        expect(await flow("Lorem", "[Finished]", "ipsum dolor sit")).toBe(" ipsum dolor sit");
    });

    it("text ending with a space → single call, no leading space", async () => {
        expect(await flow("Lorem ", "[Finished]", "ipsum dolor sit")).toBe("ipsum dolor sit");
    });

    it("empty text → single call, no leading space", async () => {
        // continueText receives "Continue writing. " (empty text, no added space)
        let seen = "";
        const g = await computeGhost("", SYS, {
            classifyWord: async () => "[Finished]",
            continueText: async (p) => { seen = p; return "Once upon a time"; },
        });
        expect(seen).toBe("Continue writing. ");
        expect(g).toBe("Once upon a time");
    });

    it("not-finished (AI1 suffix) → ghost attaches with NO leading space", async () => {
        expect(await flow("Lorem ipsum d", "ol", "olor sit amet")).toBe("olor sit amet");
    });

    it("not-finished (AI1 full word) → attaches, model completes naturally", async () => {
        expect(await flow("Lorem ips", "ipsum", "um dolor sit")).toBe("um dolor sit");
    });

    it("not-finished (AI1 echo) → attaches, no duplication", async () => {
        expect(await flow("Lorem ipsum d", "d", "olor sit amet")).toBe("olor sit amet");
    });

    it("prompt for the continuation always has a trailing space when text lacks one", async () => {
        let seen = "";
        await computeGhost("Lorem ipsum d", SYS, {
            classifyWord: async () => "ol",
            continueText: async (p) => { seen = p; return "olor"; },
        });
        expect(seen).toBe("Continue writing. Lorem ipsum d ");
    });
});

describe("computeGhost — AI1 classification handling", () => {
    const finishedVariants = ["[Finished]", "finished", "FINISHED", "Finished.", "[finished]"];
    for (const v of finishedVariants) {
        it(`treats ${JSON.stringify(v)} as finished → leading space`, async () => {
            expect(await flow("Lorem", v, "ipsum dolor")).toBe(" ipsum dolor");
        });
    }

    const notFinishedVariants: Array<[string, string, string]> = [
        // [ai1 answer, expected ghost, why]
        ["Option B: um", "um dolor", "suffix matches continuation → attaches"],
        ["um", "um dolor", "suffix matches → attaches"],
        ["ipsum", "um dolor", "full word derived to 'um' → attaches"],
        ["", "um dolor", "empty answer → no suffix → attaches"],
        ["d", " um dolor", "suffix conflicts with continuation → AI2 wins, leading space"],
        ["ol", " um dolor", "suffix conflicts → leading space"],
        ["xyz", " um dolor", "garbage suffix conflicts → leading space"],
        ["0", " um dolor", "stuck-like suffix conflicts → leading space"],
    ];
    for (const [answer, expected, why] of notFinishedVariants) {
        it(`treats ${JSON.stringify(answer)} as not-finished → ${expected} (${why})`, async () => {
            expect(await flow("Lorem ips", answer, "um dolor")).toBe(expected);
        });
    }
});

describe("computeGhost — trimming", () => {
    it("strips leading and trailing whitespace from model output", async () => {
        expect(await flow("Lorem ", "[Finished]", "  ipsum dolor  \n")).toBe("ipsum dolor");
    });
    it("strips leading whitespace in the not-finished path too", async () => {
        expect(await flow("Lorem ips", "um", "  um dolor ")).toBe("um dolor");
    });
    it("collapses internal double spaces but preserves newlines", async () => {
        expect(await flow("Lorem ", "[Finished]", "(1/2)  sum_{v in V}  deg(v)\n\nnext")).toBe("(1/2) sum_{v in V} deg(v)\n\nnext");
    });
});

describe("computeGhost — stuck markers and empty output → null", () => {
    it("'0'", async () => { expect(await flow("Lorem", "[Finished]", "0")).toBeNull(); });
    it("'0.'", async () => { expect(await flow("Lorem", "[Finished]", "0.")).toBeNull(); });
    it("'0 '", async () => { expect(await flow("Lorem", "[Finished]", "0 ")).toBeNull(); });
    it("'0!'", async () => { expect(await flow("Lorem", "[Finished]", "0!")).toBeNull(); });
    it("empty string", async () => { expect(await flow("Lorem", "[Finished]", "")).toBeNull(); });
    it("whitespace only", async () => { expect(await flow("Lorem", "[Finished]", "   ")).toBeNull(); });
    it("stuck marker in the not-finished path", async () => { expect(await flow("Lorem ips", "um", "0")).toBeNull(); });
    it("stuck marker in the trailing-space path", async () => { expect(await flow("Lorem ", "[Finished]", "0")).toBeNull(); });
    it("isStuckMarker utility", () => {
        expect(isStuckMarker("0")).toBe(true);
        expect(isStuckMarker(" 0. ")).toBe(true);
        expect(isStuckMarker("0!")).toBe(true);
        expect(isStuckMarker("10")).toBe(false);
        expect(isStuckMarker("0xFF")).toBe(false);
        expect(isStuckMarker("zero")).toBe(false);
    });
});

describe("computeGhost — aborts (cursor moved) → null", () => {
    it("classify returns null", async () => {
        expect(await flow("Lorem ips", null, "um dolor")).toBeNull();
    });
    it("continue returns null", async () => {
        expect(await flow("Lorem", "[Finished]", null)).toBeNull();
    });
    it("continue returns null in the trailing-space path", async () => {
        expect(await flow("Lorem ", "[Finished]", null)).toBeNull();
    });
});

describe("computeGhost — sentence limiting", () => {
    const three = "One sentence. Two sentences! Three?";
    it("limitSentences keeps only the first sentence", () => {
        expect(limitSentences(three, 1)).toBe("One sentence.");
    });
    it("limitSentences keeps two", () => {
        expect(limitSentences(three, 2)).toBe("One sentence. Two sentences!");
    });
    it("no limit (undefined/0) keeps everything", () => {
        expect(limitSentences(three, undefined)).toBe(three);
        expect(limitSentences(three, 0)).toBe(three);
    });
    it("fewer sentences than the limit → unchanged", () => {
        expect(limitSentences("Just one.", 3)).toBe("Just one.");
    });
    it("flow applies maxSentences to the ghost", async () => {
        const g = await computeGhost("Lorem", SYS, {
            classifyWord: async () => "[Finished]",
            continueText: async () => "ipsum dolor sit. Second sentence. Third one.",
        }, { maxSentences: 1 });
        expect(g).toBe(" ipsum dolor sit.");
    });
    it("mid-word completion survives sentence limiting", async () => {
        const g = await computeGhost("Lorem ipsum d", SYS, {
            classifyWord: async () => "ol",
            continueText: async () => "olor sit amet. Sed do eiusmod.",
        }, { maxSentences: 1 });
        expect(g).toBe("olor sit amet.");
    });
});

describe("buildSystemPromptFrom — per-document prompts", () => {
    const base = "Base prompt";
    it("no frontmatter → base prompt", () => {
        expect(buildSystemPromptFrom(undefined, base, true)).toBe(base);
    });
    it("ai-prompt replaces the base entirely", () => {
        expect(buildSystemPromptFrom({ "ai-prompt": "Custom" }, base, true)).toBe("Custom");
    });
    it("ai-prompt wins over ai-context", () => {
        expect(buildSystemPromptFrom({ "ai-prompt": "Custom", "ai-context": "Ctx" }, base, true)).toBe("Custom");
    });
    it("ai-context appends when gated on", () => {
        expect(buildSystemPromptFrom({ "ai-context": "Writing a report" }, base, true))
            .toBe("Base prompt\n\nDOCUMENT CONTEXT: Writing a report");
    });
    it("ai-context ignored when gated off", () => {
        expect(buildSystemPromptFrom({ "ai-context": "Writing a report" }, base, false)).toBe(base);
    });
    it("empty/whitespace values are ignored", () => {
        expect(buildSystemPromptFrom({ "ai-prompt": "   " }, base, true)).toBe(base);
        expect(buildSystemPromptFrom({ "ai-context": "" }, base, true)).toBe(base);
    });
    it("non-string values are ignored", () => {
        expect(buildSystemPromptFrom({ "ai-prompt": 42, "ai-context": true }, base, true)).toBe(base);
    });
});

describe("computeGhost — edge inputs", () => {
    it("unicode text (Swedish) mid-word attaches", async () => {
        expect(await flow("Hej värld", "en", "en och himmel")).toBe("en och himmel");
    });
    it("text ending with a tab goes through the classification path", async () => {
        // "word\t" does not end with a space → AI1 path, no leading space on attach
        expect(await flow("word\t", " ", "next")).toBe("next");
    });
    it("whitespace-only text → single-call path", async () => {
        expect(await flow("   ", "[Finished]", "once upon")).toBe("once upon");
    });
    it("emoji-ending text: classification path, leading space when finished", async () => {
        expect(await flow("I love 🍕", "[Finished]", "more than pizza")).toBe(" more than pizza");
    });
    it("collapseSpaces collapses tabs too", async () => {
        expect(await flow("a ", "[Finished]", "b\t\tc  d")).toBe("b c d");
    });
});

describe("computeGhost — markdown stripping", () => {
    it("strips bold/italic/code inline markers", async () => {
        expect(await flow("Lorem", "[Finished]", "**ipsum** dolor and `code` here")).toBe(" ipsum dolor and code here");
    });
    it("strips heading and list markers at line starts", async () => {
        expect(await flow("Lorem", "[Finished]", "# Heading\n- item\n1. numbered")).toBe(" Heading\nitem\nnumbered");
    });
    it("preserves LaTeX math spans", async () => {
        expect(await flow("Lorem", "[Finished]", "equation $E=mc^2$ inline")).toBe(" equation $E=mc^2$ inline");
    });
    it("stripMarkdown unit cases", () => {
        expect(stripMarkdown("**bold**")).toBe("bold");
        expect(stripMarkdown("__bold__")).toBe("bold");
        expect(stripMarkdown("*italic*")).toBe("italic");
        expect(stripMarkdown("_italic_")).toBe("italic");
        expect(stripMarkdown("`code`")).toBe("code");
        expect(stripMarkdown("~~strike~~")).toBe("strike");
        expect(stripMarkdown("```js\ncode\n```")).toBe("code\n");
        expect(stripMarkdown("> quote")).toBe("quote");
        expect(stripMarkdown("- list")).toBe("list");
        expect(stripMarkdown("## Sub")).toBe("Sub");
        expect(stripMarkdown("$\\frac{1}{2}$ stays")).toBe("$\\frac{1}{2}$ stays");
    });
});
