import { describe, it, expect } from "vitest";
import { computeGhost, stripMarkdown, isStuckMarker, limitSentences, buildSystemPromptFrom, WORD_VALIDITY_SYSTEM } from "../src/completions/flow";

const SYS = "You are an AI autocomplete engine. Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing.";

// plausible = the mocked plausible-word check result for the candidate
// (typed last word + continuation first token).
function flow(text: string, plausible: boolean | null, cont: string | null, maxSentences?: number) {
    return computeGhost(text, SYS, {
        continueText: async () => cont,
        isPlausibleWord: async () => plausible,
    }, maxSentences !== undefined ? { maxSentences } : undefined);
}

describe("computeGhost — spacing rules (plausible-word check)", () => {
    it("new word after a complete word → leading space (Loremipsum is not a word)", async () => {
        expect(await flow("Lorem", false, "ipsum dolor sit")).toBe(" ipsum dolor sit");
    });
    it("word completion attaches (i+psum=ipsum — the reported bug)", async () => {
        expect(await flow("Lorem i", true, "psum dolor sit")).toBe("psum dolor sit");
    });
    it("word completion attaches (ips+um=ipsum)", async () => {
        expect(await flow("Lorem ips", true, "um dolor sit")).toBe("um dolor sit");
    });
    it("word completion attaches (d+olor=dolor)", async () => {
        expect(await flow("Lorem ipsum d", true, "olor sit amet")).toBe("olor sit amet");
    });
    it("word completion attaches (do+lor=dolor — the 'do lor' bug)", async () => {
        expect(await flow("Lorem ipsum do", true, "lor sit amet")).toBe("lor sit amet");
    });
    it("Swedish word completion attaches (värld+en=världen)", async () => {
        expect(await flow("Hej värld", true, "en och himmel")).toBe("en och himmel");
    });
    it("text ending with a space → single call, no leading space", async () => {
        expect(await flow("Lorem ", false, "ipsum dolor sit")).toBe("ipsum dolor sit");
    });
    it("empty text → single call, no leading space", async () => {
        let seen = "";
        const g = await computeGhost("", SYS, {
            continueText: async (p) => { seen = p; return "Once upon a time"; },
            isPlausibleWord: async () => true,
        });
        expect(seen).toBe("Continue writing. ");
        expect(g).toBe("Once upon a time");
    });
    it("number + new sentence → leading space (202+The is not a word)", async () => {
        expect(await flow("the year 202", false, "The world had changed")).toBe(" The world had changed");
    });
    it("number + lowercase new word → leading space (202was is not a word)", async () => {
        expect(await flow("the year 202", false, "was a good year")).toBe(" was a good year");
    });
    it("punctuation-ending + new word → leading space (amet,+consectetur is not a word)", async () => {
        expect(await flow("amet,", false, "consectetur adipiscing")).toBe(" consectetur adipiscing");
    });
    it("punctuation-starting continuation → leading space (värld+! is not a word)", async () => {
        expect(await flow("Hej värld", false, " ! Detta är")).toBe(" ! Detta är");
    });
});

describe("computeGhost — check aborts and fallback", () => {
    it("check returns null + lowercase continuation → attaches (conservative)", async () => {
        expect(await flow("Lorem i", null, "psum dolor")).toBe("psum dolor");
    });
    it("check returns null + capitalized continuation → leading space (conservative)", async () => {
        expect(await flow("the year 202", null, "The world")).toBe(" The world");
    });
    it("continuation returns null (abort) → no ghost", async () => {
        expect(await flow("Lorem", true, null)).toBeNull();
    });
});

describe("computeGhost — the check receives the right inputs", () => {
    it("candidate = typed last word + continuation first token, with the full text", async () => {
        let seenText = "";
        let seenCandidate = "";
        await computeGhost("Lorem ipsum d", SYS, {
            continueText: async () => "olor sit amet",
            isPlausibleWord: async (text, candidate) => { seenText = text; seenCandidate = candidate; return true; },
        });
        expect(seenText).toBe("Lorem ipsum d");
        expect(seenCandidate).toBe("dolor");
    });
});

describe("computeGhost — prompt for the continuation", () => {
    it("always has a trailing space when the text lacks one", async () => {
        let seen = "";
        await computeGhost("Lorem ipsum d", SYS, {
            continueText: async (p) => { seen = p; return "olor"; },
            isPlausibleWord: async () => true,
        });
        expect(seen).toBe("Continue writing. Lorem ipsum d ");
    });
});

describe("computeGhost — trimming", () => {
    it("strips leading and trailing whitespace from model output", async () => {
        expect(await flow("Lorem ", false, "  ipsum dolor  \n")).toBe("ipsum dolor");
    });
    it("strips leading whitespace before the candidate check", async () => {
        expect(await flow("Lorem i", true, "  psum dolor ")).toBe("psum dolor");
    });
    it("collapses internal double spaces but preserves newlines", async () => {
        expect(await flow("Lorem ", false, "(1/2)  sum_{v in V}  deg(v)\n\nnext")).toBe("(1/2) sum_{v in V} deg(v)\n\nnext");
    });
});

describe("computeGhost — stuck markers and empty output → null", () => {
    it("'0'", async () => { expect(await flow("Lorem", false, "0")).toBeNull(); });
    it("'0.'", async () => { expect(await flow("Lorem", false, "0.")).toBeNull(); });
    it("'0 '", async () => { expect(await flow("Lorem", false, "0 ")).toBeNull(); });
    it("'0!'", async () => { expect(await flow("Lorem", false, "0!")).toBeNull(); });
    it("empty string", async () => { expect(await flow("Lorem", false, "")).toBeNull(); });
    it("whitespace only", async () => { expect(await flow("Lorem", false, "   ")).toBeNull(); });
    it("isStuckMarker utility", () => {
        expect(isStuckMarker("0")).toBe(true);
        expect(isStuckMarker(" 0. ")).toBe(true);
        expect(isStuckMarker("0!")).toBe(true);
        expect(isStuckMarker("10")).toBe(false);
        expect(isStuckMarker("0xFF")).toBe(false);
        expect(isStuckMarker("zero")).toBe(false);
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
        const g = await flow("Lorem ", false, "ipsum dolor sit. Second sentence. Third one.", 1);
        expect(g).toBe("ipsum dolor sit.");
    });
    it("mid-word completion survives sentence limiting", async () => {
        expect(await flow("Lorem ipsum d", true, "olor sit amet. Sed do eiusmod.", 1)).toBe("olor sit amet.");
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
    it("text ending with a tab goes through the check path", async () => {
        expect(await flow("word\t", true, "next thing")).toBe("next thing");
    });
    it("whitespace-only text → single-call path", async () => {
        expect(await flow("   ", false, "once upon")).toBe("once upon");
    });
    it("emoji-ending text: candidate is not a word → leading space", async () => {
        expect(await flow("I love 🍕", false, "more than pizza")).toBe(" more than pizza");
    });
    it("collapseSpaces collapses tabs too", async () => {
        expect(await flow("a ", false, "b\t\tc  d")).toBe("b c d");
    });
});

describe("WORD_VALIDITY_SYSTEM — prompt sanity", () => {
    it("demands a bare YES/NO answer about a plausible continuation", () => {
        expect(WORD_VALIDITY_SYSTEM).toContain("YES");
        expect(WORD_VALIDITY_SYSTEM).toContain("NO");
        expect(WORD_VALIDITY_SYSTEM).toContain("plausible continuation");
    });
});

describe("computeGhost — markdown stripping", () => {
    it("strips bold/italic/code inline markers", async () => {
        expect(await flow("Lorem", false, "**ipsum** dolor and `code` here")).toBe(" ipsum dolor and code here");
    });
    it("strips heading and list markers at line starts", async () => {
        expect(await flow("Lorem", false, "# Heading\n- item\n1. numbered")).toBe(" Heading\nitem\nnumbered");
    });
    it("preserves LaTeX math spans", async () => {
        expect(await flow("Lorem", false, "equation $E=mc^2$ inline")).toBe(" equation $E=mc^2$ inline");
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
