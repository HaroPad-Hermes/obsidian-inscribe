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
import { computeGhost, WORD_VALIDITY_SYSTEM } from "../src/completions/flow";
import { TextSplitStrategies } from "../src/extension/segmentation";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Parallel mode: BATTERY_PARALLEL=1 npm run battery (or npm run battery:parallel)
const PARALLEL = process.env.BATTERY_PARALLEL === "1";
const CONCURRENCY = 5;

// Run fn over items with at most `limit` in flight; results keep input order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (i < items.length) {
                const idx = i++;
                out[idx] = await fn(items[idx]);
            }
        })
    );
    return out;
}

const SYS = "You are an AI autocomplete engine. Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing. Continue ONLY the very last word or sentence at the end of the text. Never complete or re-emit earlier sentences, list items, or text that already exists above. Write in Markdown, matching the surrounding structure — always start a new line after a heading (## ...) before body text.";

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

// Plausible-word check endpoint override: set BATTERY_CHECK_URL to run the
// spacing-arbiter checks against a LOCAL model (llama-server/LM Studio)
// instead of the DeepSeek API — the Phase-4 acceptance gate.
const CHECK_URL = process.env.BATTERY_CHECK_URL ?? null;
const CHECK_MODEL = process.env.BATTERY_CHECK_MODEL ?? "arbiter";

async function checkChat(system: string, user: string): Promise<string> {
    if (CHECK_URL) {
        const res = await fetch(`${CHECK_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: CHECK_MODEL,
                messages: [{ role: "system", content: system }, { role: "user", content: user }],
                max_tokens: 128,
                temperature: 0,
                stream: false,
            }),
        });
        if (!res.ok) throw new Error(`CHECK HTTP ${res.status}: ${await res.text()}`);
        const d = (await res.json()) as any;
        return d.choices?.[0]?.message?.content ?? "";
    }
    return chat(system, user, 5, 0.1);
}

// FIM: raw completion with a suffix anchor (the plugin's DeepSeek path).
async function fim(prompt: string, suffix: string, maxTokens: number, temperature: number): Promise<string> {
    const res = await fetch("https://api.deepseek.com/beta/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
            model: "deepseek-v4-flash",
            prompt,
            suffix,
            max_tokens: maxTokens,
            temperature,
            stream: false,
        }),
    });
    if (!res.ok) throw new Error(`FIM HTTP ${res.status}: ${await res.text()}`);
    const d = (await res.json()) as any;
    return d.choices?.[0]?.text ?? "";
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
    suffix?: string; // text after the cursor — exercises the FIM path
}

const CASES: Case[] = [
    { typed: "Lorem", check: "complete word → ghost must START with a space (never 'Loremipsum')" },
    { typed: "Lorem ", check: "trailing space → ghost must NOT start with a space; doc must not get a double space" },
    { typed: "Lorem ipsum dolor ", check: "complete sentence + trailing space → continuation 'sit amet…'" },
    { typed: "Lorem ips", check: "mid-word → ghost must attach as 'um …' → doc word must be 'ipsum' (no 'ips um', no 'ipsipsum')" },
    { typed: "Lorem ipsum d", check: "mid-word → ghost 'olor …' → 'dolor' (no 'dd', no 'd olor')" },
    { typed: "Lorem ipsum do", check: "TRICKY (now deterministic): do+lor=dolor is a word → must ATTACH → 'dolor'. Judge." },
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
    { typed: "Hej värld", check: "Swedish mid-word → completes 'en' (non-ASCII)" },
    { typed: "```python\npri", check: "code block context → completes 'nt(' or similar" },
    { typed: "The energy is $E = m", check: "unclosed math span → completes 'c^2$' or similar" },
    { typed: "The answer is 3.1", check: "decimal number → complete or continuation; judge" },
    { typed: "I love 🍕", check: "emoji ending → leading-space continuation" },
    { typed: "First paragraph.\n\nSecon", check: "paragraph break context → completes 'Second'" },
    { typed: "The industrial revolution began in the late 18th century when mechanized textile production transformed manufacturing, and this period saw unprecedented changes in agriculture, transportation, and social structures across Europe. The introduction of the steam engine by James Watt in 1769 provided a reliable power source that", check: "long context, mid-word → completes 'could'; judge continuation coherence" },
    // ── Between-sections cases (text after the cursor → FIM path) ──
    { typed: "Section one is fully written.\n\nThe sec", suffix: "ond section is already partly written below.", check: "BETWEEN SECTIONS (FIM): mid-word at the start of section two → completes 'cond' — must NOT touch section one" },
    { typed: "The committee reviewed the proposal and re", suffix: "jected it on technical grounds.", check: "BETWEEN SECTIONS (FIM): mid-word mid-paragraph → completes 'jected' — suffix anchor must keep position" },
    { typed: "Introduction complete.\n\n", suffix: "Methods section follows after the cursor.", check: "BETWEEN SECTIONS (FIM): trailing-space at section boundary → new-section continuation that fits before the suffix" },
    { typed: "8. His speech was inspiring, and by the end, the audience was on their f", suffix: "\n9. The weather forecast predicts sunny skies, but there is a chance of a thunderstorm.\n10. She glanced at her watch and realized she was already late for the meeting.", check: "BETWEEN SECTIONS (FIM): the reported list-confusion case — completes 'eet…' on item 8, never item 5 or a fresh sentence" },
];

interface CaseResult {
    ghost: string | null;
    steps: string[];
    doc: string;
    method: "fim" | "chat";
    checkUsed: boolean;
    checkVerdict: boolean | null;
}

async function runCase(c: Case): Promise<CaseResult> {
    let method: "fim" | "chat" = "chat";
    let checkUsed = false;
    let checkVerdict: boolean | null = null;
    const ghost = await computeGhost(c.typed, SYS, {
        continueText: async (p, raw) => {
            // Mirror the service: FIM when the case has text after the cursor.
            if (raw !== undefined && c.suffix) {
                method = "fim";
                return fim(raw, c.suffix, 40, 0.5);
            }
            return chat(SYS, p, 40, 0.5);
        },
        isPlausibleWord: async (text, candidate) => {
            checkUsed = true;
            const r = (await checkChat(WORD_VALIDITY_SYSTEM, `Text: "${text}"\nIs "${candidate}" a plausible word to write here?`)).trim().toUpperCase();
            checkVerdict = r.startsWith("YES");
            return checkVerdict;
        },
    }, { maxSentences: 1 });
    const { steps, doc } = simulateTabs(c.typed, ghost ?? "");
    return { ghost, steps, doc, method, checkUsed, checkVerdict };
}

it("judgment battery (prints report — judge manually)", async () => {
    if (!KEY) {
        console.error("No DeepSeek key found (env DEEPSEEK_API_KEY or AppData\\Local\\hermes\\.env). Aborting.");
        return;
    }
    const started = Date.now();
    console.log(`\nBattery against deepseek-v4-flash — ${CASES.length} cases (${PARALLEL ? `parallel ×${CONCURRENCY}` : "sequential"}) + design experiment${CHECK_URL ? ` | plausible-word check: LOCAL (${CHECK_URL})` : " | plausible-word check: deepseek-v4-flash"}\n`);
    let results: CaseResult[];
    if (PARALLEL) {
        results = await mapLimit(CASES, CONCURRENCY, runCase);
    } else {
        results = [];
        for (const c of CASES) results.push(await runCase(c));
    }
    for (let i = 0; i < CASES.length; i++) {
        const c = CASES[i];
        const { ghost, steps, doc, method, checkUsed, checkVerdict } = results[i];
        console.log("─".repeat(72));
        console.log(`typed : ${JSON.stringify(c.typed)}${c.suffix ? "  [suffix: " + JSON.stringify(c.suffix.slice(0, 60)) + "…]" : ""}`);
        console.log(`check : ${c.check}`);
        console.log(`path  : ${method} | plausible-word check: ${checkUsed ? `USED → ${checkVerdict ? "attach" : "space"}` : "not called (trailing-space/empty case)"}`);
        console.log(`ghost : ${JSON.stringify(ghost)}`);
        console.log(`tabs  : ${JSON.stringify(steps)}`);
        console.log(`doc   : ${JSON.stringify(doc)}`);
    }
    const checkCount = results.filter((r) => r.checkUsed).length;
    const fimCount = results.filter((r) => r.method === "fim").length;
    console.log(`\nSUMMARY: plausible-word check used in ${checkCount}/${CASES.length} cases (only mid-word cases); FIM path used in ${fimCount} cases.`);
    console.log(`\nElapsed: ${((Date.now() - started) / 1000).toFixed(1)}s (${PARALLEL ? "parallel" : "sequential"})`);

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
