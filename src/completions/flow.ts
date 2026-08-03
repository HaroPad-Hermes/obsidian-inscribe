// Pure completion-flow logic — no Obsidian imports, fully unit-testable.
// The plate-mode flow: given the text up to the cursor and a system prompt,
// compute the ghost text. All spacing decisions are made HERE (code-side),
// never derived from the model's raw output.

import nlp from "compromise";

// The spacing arbiter: asks the model whether the candidate word (typed last
// word + continuation's first token) is a plausible continuation of the text.
// The FULL TEXT is included as context, so the model can reject contextually
// wrong joins ("a"+"mat"=amat is Latin but "a mat" is meant; "in"+"sight"=
// insight but "in sight" is meant) while accepting real completions
// ("i"+"psum"=ipsum, "do"+"lor"=dolor).
export const WORD_VALIDITY_SYSTEM =
    'You check if a word is a plausible continuation of a text.\n' +
    'Respond with EXACTLY "YES" or "NO". No explanations.';

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
// The essential autocomplete contract, appended to any `ai-prompt` override so
// the model still knows its job (output only the continuation, never repeat
// the typed text) even when the profile prompt is replaced entirely.
export const COMPLETION_CONSTRAINTS =
    "Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing. Continue only the very last word or sentence at the end of the text; never complete or re-emit earlier sentences or list items.";

export function buildSystemPromptFrom(
    fm: Record<string, unknown> | undefined,
    systemPrompt: string,
    aiContext: boolean
): string {
    if (!fm) return systemPrompt;
    const custom = fm["ai-prompt"];
    if (typeof custom === "string" && custom.trim()) {
        return custom.trim() + "\n\n" + COMPLETION_CONSTRAINTS;
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
    // AI 2: receives the full continuation prompt plus the raw windowed prefix
    // (no "Continue writing." instruction, no artificial trailing space) so a
    // FIM-capable provider can call its suffix endpoint. Returns the raw
    // continuation text (or null if aborted / cursor moved).
    continueText: (prompt: string, raw?: string) => Promise<string | null>;
    // The spacing arbiter: is `candidate` (typed last word + continuation's
    // first token) a plausible continuation of `text`? YES -> the continuation
    // completes the word (attach); NO -> it starts a new word (space).
    // null = aborted.
    isPlausibleWord: (text: string, candidate: string) => Promise<boolean | null>;
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
// The continuation only sees a window around the cursor: the last two lines,
// each capped at 600 chars (kept from the END — nearest the cursor). Full-
// document context confuses the model when earlier lines are unfinished: it
// completes the first dangling sentence (or re-emits the list) instead of the
// cursor word. This is plate's N-1, N design. The plausible-word check still
// receives the FULL text — only the continuation prompt is windowed.
export function continuationWindow(text: string, maxLines = 2, maxLineChars = 600): string {
    return text
        .split("\n")
        .slice(-maxLines)
        .map((line) => (line.length > maxLineChars ? line.slice(-maxLineChars) : line))
        .join("\n");
}

// Models often emit numbered lists as one run-on line ("... outdoors. 2. Don't
// ..."). Markdown needs each item on its own line — normalize sentence-end +
// "N. " into a line break. Code-decided geometry: the model's content is kept,
// only the line structure is fixed. Safe for decimals ("3.1"), ranges
// ("section 5. The"), and already-broken lists.
export function normalizeListLineBreaks(text: string): string {
    return text.replace(/([.!?])\s+(?=\d+\.\s)/g, "$1\n");
}

export async function computeGhost(
    text: string,
    systemPrompt: string,
    cb: GhostCallbacks,
    options: GhostOptions = {}
): Promise<string | null> {
    const clean = (s: string): string =>
        normalizeListLineBreaks(trimLeading(trimTrailing(limitSentences(collapseSpaces(stripMarkdown(s)), options.maxSentences))));

    // Case 1: trailing space or empty text — word boundary is unambiguous.
    if (text.endsWith(' ') || text.length === 0) {
        const windowed = continuationWindow(text);
        const sentence = await cb.continueText(`Continue writing. ${windowed}`, windowed);
        if (sentence === null) return null;
        const result = clean(sentence);
        if (!result || isStuckMarker(result)) return null;
        return result;
    }

    // Case 2: no trailing space — the continuation completes the word or
    // starts a new one. The plausible-word check decides, using the ACTUAL
    // continuation as evidence ("i"+"psum" = "ipsum" -> attach; "Lorem"+
    // "ipsum" = "Loremipsum" -> leading space). This replaces AI 1: its
    // context-free verdict was unreliable for word-prefixes ('i', 'do').
    const windowed = continuationWindow(text);
    const sentence = await cb.continueText(`Continue writing. ${windowed} `, windowed);
    if (sentence === null) return null;

    const cleaned = clean(sentence);
    if (!cleaned || isStuckMarker(cleaned)) return null;

    const lastWord = text.split(/\s/).pop() || text;
    const firstToken = cleaned.split(/\s/)[0] ?? "";
    if (!firstToken) return cleaned;

    const plausible = await cb.isPlausibleWord(text, lastWord + firstToken);
    if (plausible === null) {
        // Check aborted — conservative fallback: a capitalized continuation
        // is a new sentence (space); lowercase attaches.
        return /^[A-ZÅÄÖ0-9]/.test(cleaned) ? ' ' + cleaned : cleaned;
    }
    return plausible ? cleaned : ' ' + cleaned;
}
