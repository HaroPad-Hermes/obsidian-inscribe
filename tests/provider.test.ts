import { describe, it, expect } from "vitest";
import { fimEndpoint } from "../src/providers/openai-compat/provider";

describe("fimEndpoint", () => {
    it("strips /v1 and appends /beta/completions", () => {
        expect(fimEndpoint("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/beta/completions");
    });

    it("handles base URLs without a version segment", () => {
        expect(fimEndpoint("https://api.deepseek.com")).toBe("https://api.deepseek.com/beta/completions");
    });

    it("handles trailing slashes", () => {
        expect(fimEndpoint("https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/beta/completions");
    });

    it("handles custom ports", () => {
        expect(fimEndpoint("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234/beta/completions");
    });
});
