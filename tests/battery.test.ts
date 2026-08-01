// Judgment battery — run this when changes touch the completion flow.
//
//   npm run battery
//
// This is NOT an assertion suite: the AI has multiple valid outputs and
// semantic correctness cannot be checked algorithmically. Instead it prints
// the full evidence for each curated pitfall case — AI 1's raw answer, the
// ghost (with JSON escaping so spaces are visible), the Tab-acceptance steps
// and the final document — so a human (or Hermes) can judge pass/fail.
// The single `it` passes unconditionally; the REPORT is the deliverable.

import { it } from "vitest";
import { computeGhost, WORD_CHECK_SYSTEM } from "../src/completions/flow";
import { TextSplitStrategies } from "../src/extension/segmentation";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SYS = "You are an AI autocomplete engine. Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing.";

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

function simulateTabs(typed: string, ghost: string): { steps: string[]; doc: string } {
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

interface Case {
    typed: string;
    check: string; // what to verify when judging
}

const CASES: Case[] = [
    { typed: "Lorem", check: "complete word → ghost must START with a space (never 'Loremipsum')" },
    { typed: "Lorem ", check: "trailing space → ghost must NOT start with a space; doc must not get a double space" },
    { typed: "Lorem ipsum dolor ", check: "complete sentence + trailing space → continuation 'sit amet…'" },
    { typed: "Lorem ips", check: "mid-word → ghost must attach as 'um …' → doc word must be 'ipsum' (no 'ips um', no 'ipsipsum')" },
    { typed: "Lorem ipsum d", check: "mid-word → ghost 'olor …' → 'dolor' (no 'dd', no 'd olor')" },
    { typed: "Lorem ipsum do", check: "TRICKY: 'do' is a real word AND a prefix. AI1 may say [Finished] → ghost ' lor…' → 'do lor' = BAD. Judge what actually happens." },
    { typed: "The quick brown f", check: "mid-word → 'fox'" },
    { typed: "consectet", check: "mid-word → 'consectetur'" },
    { typed: "In the beginning God created the he", check: "mid-word → 'heavens'" },
    { typed: "The cat sat on the m", check: "mid-word → 'mat'" },
    { typed: "amet,", check: "punctuation-ending → [Finished] path, leading space, continuation" },
    { typed: "This is a test", check: "stuck-prone sentence → ghost must NOT be '0' or empty" },
    { typed: "the year 202", check: "number prefix → completes to 202…" },
    { typed: "", check: "empty note → continuation from scratch" },
    { typed: "- first item\n- secon", check: "list context, mid-word → completes 'second'; check newline handling" },
    { typed: "The theorem states that E", check: "math-flavored context, mid-word → completes 'E=mc^2' or similar; check $…$ handling" },
];

it("judgment battery (prints report — judge manually)", async () => {
    if (!KEY) {
        console.error("No DeepSeek key found (env DEEPSEEK_API_KEY or AppData\\Local\\hermes\\.env). Aborting.");
        return;
    }
    console.log(`\nBattery against deepseek-v4-flash — ${CASES.length} cases + design experiment\n`);
    for (const c of CASES) {
        const ai1 = await chat(WORD_CHECK_SYSTEM, `Text: ${c.typed}\nIs the last word complete?`, 5, 0.2);
        const ghost = await computeGhost(c.typed, SYS, {
            classifyWord: async () => ai1,
            continueText: async (p) => chat(SYS, p, 40, 0.5),
        });
        const { steps, doc } = simulateTabs(c.typed, ghost ?? "");
        console.log("─".repeat(72));
        console.log(`typed : ${JSON.stringify(c.typed)}`);
        console.log(`check : ${c.check}`);
        console.log(`AI1   : ${JSON.stringify(ai1)}`);
        console.log(`ghost : ${JSON.stringify(ghost)}`);
        console.log(`tabs  : ${JSON.stringify(steps)}`);
        console.log(`doc   : ${JSON.stringify(doc)}`);
    }

    // Design experiment: does the model emit its own leading space when given
    // no trailing space? Informs whether AI1's [Finished] verdict could be
    // replaced by trusting the continuation's own spacing.
    console.log("\n" + "=".repeat(72));
    console.log("DESIGN EXPERIMENT — prompt variants (judge which behaves better)");
    console.log("=".repeat(72));
    for (const t of ["Lorem", "Lorem ipsum do", "Lorem ipsum dolor"]) {
        const withSpace = await chat(SYS, `Continue writing. ${t} `, 40, 0.5);
        const noSpace = await chat(SYS, `Continue writing. ${t}`, 40, 0.5);
        console.log(`\ninput : ${JSON.stringify(t)}`);
        console.log(`  A) trailing space    -> ${JSON.stringify(withSpace)}`);
        console.log(`  B) no trailing space -> ${JSON.stringify(noSpace)}`);
    }
    console.log("\nReport complete — judge each case manually.");
}, 300_000);
