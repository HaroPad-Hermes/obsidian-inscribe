import { App, Editor, MarkdownView, Notice } from "obsidian";
import { ProfileService } from "src/profile/service";
import { ProviderFactory } from "src/providers/factory";
import { Suggestion } from "src/extension";
import { ProfileOptions, Settings } from "src/settings/settings";
import { Provider, ChatMessage, GenerateOnceOptions } from "src/providers/provider";
import preparePrompt from "src/completions/prompt";
import { buildSystemPromptFrom, computeGhost, WORD_VALIDITY_SYSTEM, isIncompleteFill } from "src/completions/flow";
import { buildRewriteMessages, buildGenerateMessages } from "src/completions/rewrite";
import { normalizeListLineBreaks } from "src/completions/flow";
import { DiffSession } from "src/extension/diff";
import { isVimEnabled, isVimInsertMode } from "src/completions/vim";
import nlp from "compromise";

export default class CompletionService {
    private app: App;
    private settings: Settings;
    private profileService: ProfileService;
    private providerFactory: ProviderFactory;
    private completionStatusListeners: ((isGenerating: boolean) => void)[] = [];

    constructor(
        app: App,
        settings: Settings,
        profileService: ProfileService,
        providerFactory: ProviderFactory,
    ) {
        this.app = app;
        this.settings = settings;
        this.profileService = profileService;
        this.providerFactory = providerFactory;
    }

    async *fetchCompletion(): AsyncGenerator<Suggestion> {
        this.notifyCompletionStatus(false);
        if (!this.completionEnabled()) return;

        const activeEditor = this.app.workspace.activeEditor;
        if (!activeEditor) return;
        if (!activeEditor.editor) return;

        if (!this.shouldGenerate(activeEditor.editor)) return;

        const profile = this.profileService.getActiveProfile();
        const provider = this.providerFactory.getProvider(profile.provider);
        const options = profile.completionOptions;

        // Stop any previous generation
        await provider.abort();

        // Plate-mode uses the raw text up to the cursor (no template).
        const useTwoPrompt = options.twoPromptFlow && !!provider.generateOnce;
        const prompt = useTwoPrompt
            ? this.getPreCursorText(activeEditor.editor)
            : preparePrompt(activeEditor.editor, options.userPrompt);

        this.notifyCompletionStatus(true);
        yield* this.complete(activeEditor.editor, provider, prompt, options, useTwoPrompt);
        this.notifyCompletionStatus(false);
    }

    onCompletionStatusChange(listener: (isGenerating: boolean) => void) {
        this.completionStatusListeners.push(listener);
    }

    completionEnabled(): boolean {
        return this.settings.enabled && this.profileService.getActivePathConfig().enabled;
    }

    // Local spacing arbiter: OpenAI-compatible call to the fine-tuned model
    // (llama-server --reasoning off). Returns "YES"/"NO", or null on any
    // failure so the caller can fall back to the provider API.
    private async localPlausibleWord(system: string, user: string): Promise<string | null> {
        const { baseUrl, model, timeoutMs } = this.settings.arbiter;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model,
                    messages: [{ role: "system", content: system }, { role: "user", content: user }],
                    max_tokens: 128,
                    temperature: 0,
                    stream: false,
                }),
                signal: controller.signal,
            });
            if (!res.ok) return null;
            const d = (await res.json()) as any;
            const content: string | undefined = d?.choices?.[0]?.message?.content;
            if (!content) return null;
            const t = content.trim().toUpperCase();
            return t.startsWith("YES") ? "YES" : t.startsWith("NO") ? "NO" : null;
        } catch (error) {
            console.error("Inscribe: local arbiter failed", error);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    private notifyCompletionStatus(isGenerating: boolean) {
        for (const listener of this.completionStatusListeners) {
            listener(isGenerating);
        }
    }

    private async *complete(editor: Editor, provider: Provider, prompt: string, options: ProfileOptions, useTwoPrompt: boolean): AsyncGenerator<Suggestion> {
        // Legacy streaming path (no two-prompt support or disabled)
        if (!useTwoPrompt || !provider.generateOnce) {
            for await (let text of provider.generate(editor, prompt, options)) {
                text = text.trim();

                if (this.settings.suggestionControl.outputLimit.enabled) {
                    const sentences = nlp(text).sentences().out('array');
                    if (sentences.length > this.settings.suggestionControl.outputLimit.sentences) {
                        // Take only the first N sentences
                        text = sentences.slice(0, this.settings.suggestionControl.outputLimit.sentences).join(' ');
                        yield { text: text };
                        break;
                    }
                }

                yield { text: text };
            }
            return;
        }

        // ─── Plate-mode completion (logic in flow.ts) ───
        // Spacing is decided by CODE, never by the model's output. See
        // src/completions/flow.ts for the exact rules and rationale.
        const initialPosition = editor.getCursor();
        const system = this.buildSystemPrompt(options);
        const text = prompt;

        const moved = () => this.cursorMoved(editor, initialPosition);
        const generate = async (messages: ChatMessage[], opts: Partial<GenerateOnceOptions>): Promise<string | null> => {
            let result: string;
            try {
                result = await provider.generateOnce!(messages, { model: options.model, ...opts });
            } catch (error) {
                // Parallel calls: one failing request must not reject the whole
                // fetch (Promise.all). Treat it as an abort → no ghost.
                console.error("Inscribe: completion request failed", error);
                return null;
            }
            if (moved()) {
                await provider.abort();
                return null;
            }
            return result;
        };

        // Text after the cursor, capped — the FIM suffix anchor.
        const suffixText = editor
            .getValue()
            .slice(editor.posToOffset(editor.getCursor()))
            .slice(0, 4000);

        const ghost = await computeGhost(text, system, {
            continueText: async (p, raw) => {
                // FIM path: when the provider exposes a suffix endpoint and
                // there IS text after the cursor, the raw prefix + suffix
                // anchor the position structurally (no "which dangling
                // sentence?" ambiguity). Chat path otherwise.
                let fimResult: string | null = null;
                let fimTried = false;
                if (raw !== undefined && suffixText && provider.generateFimOnce) {
                    fimTried = true;
                    try {
                        fimResult = await provider.generateFimOnce!(raw, suffixText, {
                            model: options.model,
                            maxTokens: options.continuationTokens,
                            temperature: options.temperature,
                        });
                    } catch (error) {
                        console.error("Inscribe: FIM completion failed — falling back to chat path", error);
                    }
                }
                if (fimTried && fimResult !== null) {
                    // FIM fills are boundary-sized: an empty or stranded-unit
                    // fill ("the", "and") leaves the sentence hanging — re-run
                    // via chat to get a real continuation. Skipped inside code
                    // blocks, where short fills are legitimate.
                    const inCode = raw !== undefined && raw.includes("```");
                    if (
                        this.settings.suggestionControl.fimShortFillFallback &&
                        !inCode &&
                        isIncompleteFill(fimResult)
                    ) {
                        console.error("Inscribe: FIM fill incomplete — falling back to chat path");
                        fimResult = null;
                    } else {
                        if (moved()) {
                            await provider.abort();
                            return null;
                        }
                        return fimResult;
                    }
                }
                return generate(
                    [{ role: 'system', content: system }, { role: 'user', content: p }],
                    { maxTokens: options.continuationTokens, temperature: options.temperature });
            },
            isPlausibleWord: async (text, candidate) => {
                const user = `Text: "${text}"\nIs "${candidate}" a plausible word to write here?`;
                // Local spacing arbiter (fine-tuned Qwen3.5-2B on llama-server
                // with --reasoning off): deterministic, ~50-80ms. Falls back to
                // the active provider's API in "auto" mode.
                if (this.settings.arbiter.mode !== "api") {
                    const local = await this.localPlausibleWord(WORD_VALIDITY_SYSTEM, user);
                    if (local !== null) return local === "YES";
                    if (this.settings.arbiter.mode === "local") return null;
                }
                const r = await generate(
                    [{ role: 'system', content: WORD_VALIDITY_SYSTEM }, { role: 'user', content: user }],
                    { maxTokens: 5, temperature: 0.1 });
                if (r === null) return null;
                return r.trim().toUpperCase().startsWith("YES");
            },
        }, {
            maxSentences: this.settings.suggestionControl.outputLimit.enabled
                ? this.settings.suggestionControl.outputLimit.sentences
                : undefined,
        });
        if (ghost === null) return;
        yield { text: ghost };
    }

    private getPreCursorText(editor: Editor): string {
        const cursor = editor.getCursor();
        return editor.getRange({ line: 0, ch: 0 }, cursor);
    }

    // Rewrite the current selection via the active profile's provider. The
    // selection is wrapped in <selected> markers with surrounding text as
    // context (up to 8000 chars each side). Returns the diff session for the
    // inline Accept/Discard view, or null on failure / empty result.
    async rewriteSelection(instruction: string, thinking: boolean): Promise<DiffSession | null> {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor;
        if (!editor) return null;
        const selection = editor.getSelection();
        if (!selection.trim()) return null;

        const profile = this.profileService.getActiveProfile();
        const provider = this.providerFactory.getProvider(profile.provider);
        const options = profile.completionOptions;

        const from = editor.posToOffset(editor.getCursor("from"));
        const to = editor.posToOffset(editor.getCursor("to"));
        const fullText = editor.getValue();

        const messages = buildRewriteMessages({
            instruction,
            selection,
            before: fullText.slice(0, from),
            after: fullText.slice(to),
        });

        try {
            const result = await provider.generateOnce!(messages, {
                model: options.model,
                maxTokens: 4000, // thinking-enabled rewrites need headroom (reasoning tokens count against the budget)
                temperature: 0.5,
                thinking: thinking ? "enabled" : "disabled",
            });
            const rewritten = normalizeListLineBreaks((result || "").trim());
            if (!rewritten) {
                new Notice("Inscribe: the model returned nothing");
                return null;
            }
            return { from, to, original: selection, rewritten };
        } catch (error) {
            console.error("Inscribe: rewrite failed", error);
            new Notice("Inscribe: rewrite failed — see console");
            return null;
        }
    }

    // Generate new text from scratch at the cursor (or replacing the current
    // selection). The whole document around the cursor is sent as context
    // (up to 20000 chars each side), with a <cursor> marker. Streaming: yields
    // the growing text so the caller can render it incrementally (inline diff
    // preview) instead of waiting for the full generation. Providers without
    // streamOnce fall back to a single non-streaming yield.
    async *generateTextStream(
        instruction: string,
        thinking: boolean,
        signal?: AbortSignal
    ): AsyncGenerator<string> {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor;
        if (!editor) return;

        const profile = this.profileService.getActiveProfile();
        const provider = this.providerFactory.getProvider(profile.provider);
        const options = profile.completionOptions;

        const from = editor.posToOffset(editor.getCursor("from"));
        const to = editor.posToOffset(editor.getCursor("to"));
        const fullText = editor.getValue();

        const messages = buildGenerateMessages({
            instruction,
            before: fullText.slice(0, from),
            after: fullText.slice(to),
        });
        const opts = {
            model: options.model,
            maxTokens: 4000, // thinking-enabled generation needs headroom (reasoning tokens count against the budget)
            temperature: 0.7,
            thinking: thinking ? ("enabled" as const) : ("disabled" as const),
        };
        if (provider.streamOnce) {
            yield* provider.streamOnce(messages, opts, signal);
            return;
        }
        // Non-streaming fallback: yield the full result in one chunk.
        const result = await provider.generateOnce!(messages, opts);
        if (result) yield result;
    }

    private buildSystemPrompt(options: ProfileOptions): string {
        const file = this.app.workspace.getActiveFile();
        const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
        return buildSystemPromptFrom(fm, options.systemPrompt, options.aiContext);
    }

    private shouldGenerate(editor: Editor): boolean {
        if (this.settings.suggestionControl.manualActivationKey) {
            // If manual activation is enabled, skip auto-trigger rules
            return true;
        }

        // Check if the editor is in Vim insert mode
        if (isVimEnabled(editor) && !isVimInsertMode(editor)) {
            return false;
        }

        const cursor = editor.getCursor();
        const currentLine = editor.getLine(cursor.line);

        const rules = this.settings.suggestionControl.activationRules;

        if (rules.requireNonEmptyLine) {
            if (!currentLine || currentLine.length === 0) return false;
        }

        if (rules.requireCursorNotAtStart) {
            if (cursor.ch === 0) return false;
        }

        if (rules.requireSpaceBeforeCursor) {
            const lastChar = currentLine[cursor.ch - 1];
            if (lastChar !== " ") return false;
        }

        return true;
    }

    private cursorMoved(editor: Editor, initialPosition: { line: number, ch: number }): boolean {
        const currentPosition = editor.getCursor();
        return currentPosition.line !== initialPosition.line || currentPosition.ch !== initialPosition.ch;
    }
}
