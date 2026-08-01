import { App, Editor, MarkdownView, Notice } from "obsidian";
import { ProfileService } from "src/profile/service";
import { ProviderFactory } from "src/providers/factory";
import { Suggestion } from "src/extension";
import { ProfileOptions, Settings } from "src/settings/settings";
import { Provider, ChatMessage, GenerateOnceOptions } from "src/providers/provider";
import preparePrompt from "src/completions/prompt";
import { buildSystemPromptFrom, computeGhost, WORD_VALIDITY_SYSTEM } from "src/completions/flow";
import { buildRewriteMessages } from "src/completions/rewrite";
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

        const ghost = await computeGhost(text, system, {
            continueText: (p) => generate(
                [{ role: 'system', content: system }, { role: 'user', content: p }],
                { maxTokens: options.continuationTokens, temperature: options.temperature }),
            isPlausibleWord: async (text, candidate) => {
                const r = await generate(
                    [{ role: 'system', content: WORD_VALIDITY_SYSTEM }, { role: 'user', content: `Text: "${text}"\nIs "${candidate}" a plausible word to write here?` }],
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
                maxTokens: 1600,
                temperature: 0.5,
                thinking: thinking ? "enabled" : "disabled",
            });
            const rewritten = (result || "").trim();
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
