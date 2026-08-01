import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeGhost, isStuckMarker, WORD_VALIDITY_SYSTEM } from "../src/completions/flow";
import { TextSplitStrategies } from "../src/extension/segmentation";

// Live smoke against the real model. The AI is non-deterministic with
// multiple valid outputs, so every assertion is an INVARIANT (no stuck
// markers, no double spaces, no duplicated prefixes) — semantic outcomes are
// judged in the battery, never asserted here. Skips without a DeepSeek key.

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
const SYS = "You are an AI autocomplete engine. Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing. Continue ONLY the very last word or sentence at the end of the text. Never complete or re-emit earlier sentences, list items, or text that already exists above.";

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
    return { steps, doc };
}

interface LiveCase {
    typed: string;
    runs?: number;
}

const CASES: LiveCase[] = [
    { typed: "Lorem", runs: 2 },
    { typed: "Lorem ", runs: 2 },
    { typed: "Lorem ips", runs: 2 },
    { typed: "Lorem ipsum d", runs: 2 },
    { typed: "Lorem ipsum do", runs: 2 },
    { typed: "The quick brown f", runs: 1 },
    { typed: "consectet", runs: 1 },
    { typed: "In the beginning God created the he", runs: 1 },
    { typed: "The cat sat on the m", runs: 1 },
    { typed: "amet,", runs: 1 },
    { typed: "This is a test", runs: 1 },
];

describe.skipIf(!KEY)("live smoke (DeepSeek V4 Flash)", () => {
    it.each(CASES)("$typed", async (c) => {
        const runs = c.runs ?? 2;
        for (let i = 0; i < runs; i++) {
            const ghost = await computeGhost(c.typed, SYS, {
                continueText: async (p) => chat(SYS, p, 40, 0.5),
                isPlausibleWord: async (text, candidate) => {
                    const r = (await chat(WORD_VALIDITY_SYSTEM, `Text: "${text}"\nIs "${candidate}" a plausible word to write here?`, 5, 0.1)).trim().toUpperCase();
                    return r.startsWith("YES");
                },
            }, { maxSentences: 1 });

            // Invariant 1: a ghost must exist and must not be a stuck marker.
            expect(ghost, `run ${i + 1}: ghost must not be null`).not.toBeNull();
            expect(isStuckMarker(ghost!), `run ${i + 1}: not a stuck marker`).toBe(false);

            // Invariant 2: the Tab-accepted document must be well-formed:
            // no double spaces, no trailing space, and no duplicated prefix
            // (the "ipsipsum" / "dd" failure class).
            const { doc } = simulateTabs(c.typed, ghost!);
            expect(doc.includes("  "), `run ${i + 1}: no double space in "${doc}"`).toBe(false);
            expect(doc.endsWith(" "), `run ${i + 1}: no trailing space`).toBe(false);
            const lastWord = c.typed.trimEnd().split(/\s+/).pop() ?? "";
            const firstToken = ghost!.trim().split(/\s+/)[0] ?? "";
            const formed = ghost!.startsWith(" ") ? firstToken : lastWord + firstToken;
            if (lastWord && formed.length > lastWord.length) {
                expect(
                    formed.startsWith(lastWord + lastWord),
                    `run ${i + 1}: no duplicated prefix ("${formed}")`
                ).toBe(false);
            }
        }
    }, 60_000);
});
