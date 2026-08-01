import { describe, it, expect } from "vitest";
import { TextSplitStrategies } from "../src/extension/segmentation";

describe("TextSplitStrategies.word", () => {
    it("accepts up to and including the first space", () => {
        expect(TextSplitStrategies.word("ipsum dolor sit")).toEqual({ accepted: "ipsum ", remaining: "dolor sit" });
    });
    it("a leading space is its own token (ghost spacing case)", () => {
        expect(TextSplitStrategies.word(" ipsum dolor")).toEqual({ accepted: " ", remaining: "ipsum dolor" });
    });
    it("a word completion attaches without space", () => {
        expect(TextSplitStrategies.word("um dolor")).toEqual({ accepted: "um ", remaining: "dolor" });
    });
    it("single word with no trailing space is accepted whole", () => {
        expect(TextSplitStrategies.word("ipsum")).toEqual({ accepted: "ipsum", remaining: "" });
    });
    it("single completion token is accepted whole", () => {
        expect(TextSplitStrategies.word("um")).toEqual({ accepted: "um", remaining: "" });
    });
    it("empty text", () => {
        expect(TextSplitStrategies.word("")).toEqual({ accepted: "", remaining: "" });
    });
});

describe("TextSplitStrategies.sentence", () => {
    it("accepts up to and including the first sentence boundary (space stays in remaining)", () => {
        expect(TextSplitStrategies.sentence("Lorem ipsum. Dolor sit amet")).toEqual({
            accepted: "Lorem ipsum.", remaining: " Dolor sit amet",
        });
    });
    it("no boundary → accept everything", () => {
        expect(TextSplitStrategies.sentence("Lorem ipsum")).toEqual({ accepted: "Lorem ipsum", remaining: "" });
    });
    it("handles ? and !", () => {
        expect(TextSplitStrategies.sentence("Really? Yes! No")).toEqual({ accepted: "Really?", remaining: " Yes! No" });
    });
});

describe("TextSplitStrategies.paragraph", () => {
    it("accepts up to and including the first double newline", () => {
        expect(TextSplitStrategies.paragraph("one\n\ntwo")).toEqual({ accepted: "one\n\n", remaining: "two" });
    });
    it("no paragraph break → everything", () => {
        expect(TextSplitStrategies.paragraph("one two")).toEqual({ accepted: "one two", remaining: "" });
    });
});

describe("TextSplitStrategies.full", () => {
    it("accepts the entire suggestion", () => {
        expect(TextSplitStrategies.full("anything at all")).toEqual({ accepted: "anything at all", remaining: "" });
    });
});
