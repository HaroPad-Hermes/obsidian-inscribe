// Rewrite-selection flow: pure prompt construction (unit-testable) plus the
// preset operations offered in the edit-selection modal.

export interface RewritePreset {
    id: string;
    label: string;
    instruction: string;
}

export const REWRITE_PRESETS: RewritePreset[] = [
    { id: "rephrase", label: "Rephrase", instruction: "Rephrase the selected text while keeping its meaning and style consistent with the surrounding text." },
    { id: "shorten", label: "Shorten", instruction: "Shorten the selected text, keeping the essential meaning. Aim for roughly half the length." },
    { id: "expand", label: "Expand", instruction: "Expand the selected text with more detail and depth, keeping the same style and tone." },
    { id: "formal", label: "Make more formal", instruction: "Rewrite the selected text to be more formal and professional." },
    { id: "grammar", label: "Fix grammar and spelling", instruction: "Fix grammar, spelling, and punctuation errors in the selected text. Change as little as possible." },
    { id: "latex", label: "Convert math to LaTeX", instruction: "Convert any math in the selected text to LaTeX notation ($...$ inline, $$...$$ block). Keep the surrounding prose unchanged." },
];

export const REWRITE_SYSTEM_PROMPT =
    "You rewrite text according to the user's instruction. The text to rewrite is marked with <selected> and </selected>; the surrounding <context_before>/<context_after> blocks are provided for style and continuity only.\n" +
    "Output ONLY the rewritten text for the selected part — no explanations, no meta-text, no markers. Preserve markdown formatting. Keep the original language unless the instruction says otherwise. Write in Markdown: preserve headings and list structure — never expand a heading or rubric into a large body.";

const CONTEXT_LIMIT = 8000; // characters of context before/after the selection

export interface RewriteInput {
    instruction: string;
    selection: string;
    before: string;
    after: string;
}

// Build the messages for a rewrite request.
export function buildRewriteMessages(input: RewriteInput): Array<{ role: "system" | "user"; content: string }> {
    const before = input.before.slice(-CONTEXT_LIMIT);
    const after = input.after.slice(0, CONTEXT_LIMIT);
    return [
        { role: "system", content: REWRITE_SYSTEM_PROMPT },
        {
            role: "user",
            content: [
                `Instruction: ${input.instruction}`,
                "",
                before ? `<context_before>\n${before}\n</context_before>` : "<context_before></context_before>",
                "",
                `<selected>\n${input.selection}\n</selected>`,
                "",
                after ? `<context_after>\n${after}\n</context_after>` : "<context_after></context_after>",
            ].join("\n"),
        },
    ];
}

// ── Generate from scratch ────────────────────────────────────────────────

export const GENERATE_SYSTEM_PROMPT =
    "You write new text at the position marked <cursor>. Use the surrounding context for style, tone, and continuity.\n" +
    "Output ONLY the text to insert — no explanations, no meta-text, no markers. Preserve markdown formatting. Write in Markdown: keep headings as headings and lists as lists. Default to a short paragraph (3-5 sentences) unless the instruction asks for more.";

const GENERATE_CONTEXT_LIMIT = 20000; // generous context each side of the cursor

export interface GenerateInput {
    instruction: string;
    before: string;
    after: string;
}

export function buildGenerateMessages(input: GenerateInput): Array<{ role: "system" | "user"; content: string }> {
    const before = input.before.slice(-GENERATE_CONTEXT_LIMIT);
    const after = input.after.slice(0, GENERATE_CONTEXT_LIMIT);
    return [
        { role: "system", content: GENERATE_SYSTEM_PROMPT },
        {
            role: "user",
            content: [
                `Instruction: ${input.instruction}`,
                "",
                before ? `<context_before>\n${before}\n</context_before>` : "<context_before></context_before>",
                "",
                "<cursor>",
                "",
                after ? `<context_after>\n${after}\n</context_after>` : "<context_after></context_after>",
            ].join("\n"),
        },
    ];
}
