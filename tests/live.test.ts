import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeGhost, isStuckMarker } from "../src/completions/flow";
import { TextSplitStrategies } from "../src/extension/segmentation";

// Live battery against the real model. The AI is non-deterministic with
// multiple valid outputs, so every assertion is a JUDGMENT (spacing rules,
// completed-word outcomes, no stuck markers) — never an exact string match.
// Skips automatically when no DeepSeek key is available.

function loadKey(): string | null {
    if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
    try {
        const p = path.join(os.homedir(), "AppData", "Local", "hermes", ".env");
        const txt = fs.readFileSync(p, "utf8");
        const m = txt.match(/^DEEPSEEK_API_KEY=(.+)$/m);
        return m ? m[1].trim().replace(/^"|"$/g, "") : null;
    } catch {
        return null;
    }
}

const KEY = loadKey();
const SYS = "You are an AI autocomplete engine. Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing.";

async function chat(system: string, user: string, maxTokens: number, temperature: number): Promise<string> {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
            model: "deepseek-v4-flash",
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            max_tokens: maxTokens,
            temperature,
            stream: false,
            thinking: { type: "disabled" },
        }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const d = (await res.json()) as any;
    return d.choices[0].message.content ?? "";
}

function simulateTabs(typed: string, ghost: string): { doc: string; steps: string[] } {
    let doc = typed;
    let rem = ghost;
    const steps: string[] = [];
    while (rem) {
        const { accepted, remaining } = TextSplitStrategies.word(rem);
        doc += accepted;
        steps.push(accepted);
        rem = remaining;
    }
    return { doc, steps };
}

interface LiveCase {
    typed: string;
    // If set: the completed word (typed last word + first ghost token, or the
    // first ghost word when a leading space was inserted) must be one of these.
    completions?: string[];
    // If set: the ghost must start with a space (word judged complete).
    expectLeadingSpace?: boolean;
    runs?: number;
}

const CASES: LiveCase[] = [
    { typed: "Lorem", expectLeadingSpace: true, runs: 3 },
    { typed: "Lorem ", runs: 3 },
    { typed: "Lorem ips", completions: ["ipsum"], runs: 3 },
    { typed: "Lorem ipsum d", completions: ["dolor"], runs: 3 },
    { typed: "Lorem ipsum do", completions: ["dolor"], runs: 3 },
    { typed: "The quick brown f", completions: ["fox"], runs: 2 },
    { typed: "consectet", completions: ["consectetur"], runs: 2 },
    { typed: "In the beginning God created the he", completions: ["heavens"], runs: 2 },
    { typed: "The cat sat on the m", completions: ["mat"], runs: 2 },
    { typed: "amet,", expectLeadingSpace: true, runs: 2 },
    { typed: "This is a test", expectLeadingSpace: true, runs: 2 },
];

describe.skipIf(!KEY)("live battery (DeepSeek V4 Flash)", () => {
    it.each(CASES)("$typed", async (c) => {
        const runs = c.runs ?? 2;
        for (let i = 0; i < runs; i++) {
            const ghost = await computeGhost(c.typed, SYS, {
                classifyWord: async (t) => chat(
                    "You check if the last word in a text fragment is complete.\n\nRespond with EXACTLY \"[Finished]\" (with brackets) if the last word is complete.\nRespond with ONLY the missing characters if the last word is incomplete.\n\nCRITICAL: No explanations. No punctuation. No extra text. No spaces. Just the answer.",
                    `Text: ${t}\nIs the last word complete?`,
                    5, 0.2),
                continueText: async (p) => chat(SYS, p, 40, 0.5),
            });

            // Judgment 1: a ghost must exist and must not be a stuck marker.
            expect(ghost, `run ${i + 1}: ghost must not be null`).not.toBeNull();
            expect(isStuckMarker(ghost!), `run ${i + 1}: not a stuck marker`).toBe(false);

            // Judgment 2: leading space rule (code-decided).
            if (c.expectLeadingSpace !== undefined) {
                expect(ghost!.startsWith(" "), `run ${i + 1}: leading space`).toBe(c.expectLeadingSpace);
            }

            // Judgment 3: the completed word must be one of the expected words.
            if (c.completions) {
                const lastWord = c.typed.split(" ").pop()!;
                const firstToken = ghost!.trim().split(/\s+/)[0] ?? "";
                const completed = ghost!.startsWith(" ") ? firstToken : lastWord + firstToken;
                expect(
                    c.completions.includes(completed),
                    `run ${i + 1}: completed word "${completed}" (from "${lastWord}" + "${firstToken}")`
                ).toBe(true);
            }

            // Judgment 4: the Tab-accepted document must be well-formed:
            // no double spaces, no trailing space, and no duplicated prefix
            // (the "ipsipsum" / "dd" failure class).
            const { doc } = simulateTabs(c.typed, ghost!);
            expect(doc.includes("  "), `run ${i + 1}: no double space in "${doc}"`).toBe(false);
            expect(doc.endsWith(" "), `run ${i + 1}: no trailing space`).toBe(false);
            const lastWord = c.typed.split(" ").pop()!;
            const firstToken = ghost!.trim().split(/\s+/)[0] ?? "";
            const formed = ghost!.startsWith(" ") ? firstToken : lastWord + firstToken;
            if (formed.length > lastWord.length) {
                expect(
                    formed.startsWith(lastWord + lastWord),
                    `run ${i + 1}: no duplicated prefix ("${formed}")`
                ).toBe(false);
            }
        }
    });
});
