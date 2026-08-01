// Pure completion-flow logic — no Obsidian imports, fully unit-testable.
// The plate-mode flow: given the text up to the cursor and a system prompt,
// compute the ghost text. All spacing decisions are made HERE (code-side),
// never derived from the model's raw output.

import nlp from "compromise";

// AI 1: classifies whether the last word is complete. The verdict decides the
// ghost's leading space (code-side), never the model's raw output.
export const WORD_CHECK_SYSTEM =
    'You check if the last word in a text fragment is complete.\n\n' +
    'Respond with EXACTLY "[Finished]" (with brackets) if the last word is complete.\n' +
    'Respond with ONLY the missing characters if the last word is incomplete.\n\n' +
    'CRITICAL: No explanations. No punctuation. No extra text. No spaces. Just the answer.';

export const trimTrailing = (s: string): string => s.replace(/\s+$/, "");
export const trimLeading = (s: string): string => s.replace(/^\s+/, "");
// Collapse runs of spaces/tabs (but not newlines) — models sometimes emit
// double spaces (e.g. "(1/2)  sum_{v ...}").
export const collapseSpaces = (s: string): string => s.replace(/[ \t]{2,}/g, " ");

// Limit the output to at most `max` sentences (compromise-based, same as the
// legacy streaming path). Undefined/0 means no limit.
export function limitSentences(s: string, max?: number): string {
    if (!max || max <= 0) return s;
    const sentences = nlp(s).sentences().out("array") as string[];
    if (sentences.length <= max) return s;
    return sentences.slice(0, max).join(" ").trimEnd();
}

// Build the effective system prompt from note frontmatter:
//  - `ai-prompt`  replaces the profile prompt entirely (always honored)
//  - `ai-context` appends DOCUMENT CONTEXT (gated by the aiContext toggle)
export function buildSystemPromptFrom(
    fm: Record<string, unknown> | undefined,
    systemPrompt: string,
    aiContext: boolean
): string {
    if (!fm) return systemPrompt;
    const custom = fm["ai-prompt"];
    if (typeof custom === "string" && custom.trim()) {
        return custom.trim();
    }
    if (aiContext) {
        const ctx = fm["ai-context"];
        if (typeof ctx === "string" && ctx.trim()) {
            return systemPrompt + "\n\nDOCUMENT CONTEXT: " + ctx.trim();
        }
    }
    return systemPrompt;
}

// Some models emit "0" (optionally with trailing punctuation) as a learned
// stuck/refusal token. Treat it as an empty result — no ghost.
export const isStuckMarker = (s: string): boolean => /^0[\s.,;!?]*$/.test(s.trim());

// Strip markdown formatting from model output so the ghost reads as plain
// text. Math spans ($...$, $$...$$) are preserved — class notes use LaTeX.
export function stripMarkdown(s: string): string {
    let t = s;
    const math: string[] = [];
    t = t.replace(/\$\$?[^$\n]+\$\$?/g, (m) => {
        math.push(m);
        return `\u0000M${math.length - 1}\u0000`;
    });
    // Code fences must be handled BEFORE inline backtick markers.
    t = t.replace(/```[^\n]*\n?|`{3}/g, '');
    t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');
    t = t.replace(/(\*|_|`)(.*?)\1/g, '$2');
    t = t.replace(/~~(.*?)~~/g, '$1');
    t = t.split('\n')
        .map((line) => line
            .replace(/^(#{1,6})\s+/, '')
            .replace(/^>\s?/, '')
            .replace(/^[-*+]\s+/, '')
            .replace(/^\d+\.\s+/, ''))
        .join('\n');
    t = t.replace(/\u0000M(\d+)\u0000/g, (_, i) => math[+i]);
    return t;
}

export interface GhostCallbacks {
    // AI 1: receives the raw cursor text, returns its raw answer
    // (or null if the request was aborted / cursor moved).
    classifyWord: (text: string) => Promise<string | null>;
    // AI 2: receives the full continuation prompt, returns the raw
    // continuation text (or null if aborted / cursor moved).
    continueText: (prompt: string) => Promise<string | null>;
}

export interface GhostOptions {
    // Limit the ghost to at most this many sentences (undefined/0 = no limit).
    maxSentences?: number;
}

// Compute the ghost text for the given pre-cursor text.
// Returns null when there is nothing to show (abort, empty, stuck marker).
//
// Spacing rules (code-decided):
//  - text ends with a space (or is empty) -> single call, no leading space
//  - AI 1 [Finished]                       -> ghost gets a leading space
//  - AI 1 not finished                     -> AI 2 completes the word naturally
//                                             from the trailing-space prompt;
//                                             ghost attaches with NO leading space
export async function computeGhost(
    text: string,
    systemPrompt: string,
    cb: GhostCallbacks,
    options: GhostOptions = {}
): Promise<string | null> {
    const clean = (s: string): string =>
        trimLeading(trimTrailing(limitSentences(collapseSpaces(stripMarkdown(s)), options.maxSentences)));

    // Case 1: trailing space or empty text — word boundary is unambiguous.
    if (text.endsWith(' ') || text.length === 0) {
        const sentence = await cb.continueText(`Continue writing. ${text}`);
        if (sentence === null) return null;
        const result = clean(sentence);
        if (!result || isStuckMarker(result)) return null;
        return result;
    }

    // Case 2: no trailing space — fire AI 1 (classification) and AI 2
    // (continuation) IN PARALLEL: their prompts are independent, AI 2 always
    // gets the raw text with a trailing space. Saves AI 1's ~0.3s latency.
    // (Wasted call only if the cursor moves during that window — results are
    // dropped anyway.)
    const [check, sentence] = await Promise.all([
        cb.classifyWord(text),
        cb.continueText(`Continue writing. ${text} `),
    ]);
    if (check === null || sentence === null) return null;

    const checkResponse = check.trim().replace(/^Option\s*[AB]:\s*/i, '');
    const isFinished = checkResponse.toLowerCase().replace(/[^a-z]/g, '') === 'finished';

    const cleaned = clean(sentence);
    if (!cleaned || isStuckMarker(cleaned)) return null;

    if (!isFinished) {
        // Cross-check AI1's not-finished verdict against AI2's continuation.
        // A leading space is added ONLY when the continuation starts a new
        // sentence (uppercase/digit) — the model did NOT complete the word
        // (fixes glued "202The"). Partial AI1 suffixes ('m' for "i") must not
        // trigger a false conflict: lowercase continuations are word
        // completions and attach directly ("psum..." -> "ipsum").
        const lastWord = text.split(/\s/).pop() || text;
        let suffix = checkResponse.trim();
        if (suffix.startsWith(lastWord) && suffix.length > lastWord.length) {
            suffix = suffix.slice(lastWord.length);
        }
        suffix = suffix.split(/\s/)[0] || '';
        const suffixMatches = !!suffix && suffix !== lastWord && cleaned.startsWith(suffix);
        const startsNewSentence = /^[A-ZÅÄÖ0-9]/.test(cleaned);
        const attaches = suffixMatches || !startsNewSentence;
        return (attaches ? '' : ' ') + cleaned;
    }

    return ' ' + cleaned;
}
