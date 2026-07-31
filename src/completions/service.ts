import { App, Editor } from "obsidian";
import { ProfileService } from "src/profile/service";
import { ProviderFactory } from "src/providers/factory";
import { Suggestion } from "src/extension";
import { ProfileOptions, Settings } from "src/settings/settings";
import { Provider, ChatMessage, GenerateOnceOptions } from "src/providers/provider";
import preparePrompt from "src/completions/prompt";
import { isVimEnabled, isVimInsertMode } from "src/completions/vim";
import nlp from "compromise";

// AI 1: classifies whether the last word is complete. The verdict decides the
// ghost's leading space (code-side), never the model's raw output.
const WORD_CHECK_SYSTEM =
    'You check if the last word in a text fragment is complete.\n\n' +
    'Respond with EXACTLY "[Finished]" (with brackets) if the last word is complete.\n' +
    'Respond with ONLY the missing characters if the last word is incomplete.\n\n' +
    'CRITICAL: No explanations. No punctuation. No extra text. No spaces. Just the answer.';

const trimTrailing = (s: string): string => s.replace(/\s+$/, "");
const trimLeading = (s: string): string => s.replace(/^\s+/, "");

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

        // ─── Plate-mode completion ───
        // Spacing is decided by CODE, never by the model's output:
        //  - text ends with a space        -> word boundary clear, single call
        //  - AI 1 says [Finished]          -> word complete, ghost gets a leading
        //                                     space (cursor has no trailing space)
        //  - AI 1 says not finished        -> AI 2 completes the word naturally from
        //                                     the trailing-space prompt; ghost attaches
        //                                     with NO leading space ("d " -> "olor ...")
        // The model's output is always trimmed on both sides before re-spacing.
        const initialPosition = editor.getCursor();
        const system = this.buildSystemPrompt(options);
        const text = prompt;

        const moved = () => this.cursorMoved(editor, initialPosition);
        const generate = async (messages: ChatMessage[], opts: Partial<GenerateOnceOptions>): Promise<string | null> => {
            const result = await provider.generateOnce!(messages, { model: options.model, ...opts });
            if (moved()) {
                await provider.abort();
                return null;
            }
            return result;
        };

        // Case 1: trailing space or empty text — word boundary is unambiguous.
        if (text.endsWith(' ') || text.length === 0) {
            const sentence = await generate(
                [{ role: 'system', content: system }, { role: 'user', content: `Continue writing. ${text}` }],
                { maxTokens: options.continuationTokens, temperature: options.temperature });
            if (sentence === null) return;
            const result = trimLeading(trimTrailing(sentence));
            if (!result.trim()) return;
            yield { text: result };
            return;
        }

        // Case 2: no trailing space — AI 1 classifies the last word.
        const checkResult = await generate(
            [{ role: 'system', content: WORD_CHECK_SYSTEM }, { role: 'user', content: `Text: ${text}\nIs the last word complete?` }],
            { maxTokens: options.wordCheckTokens, temperature: 0.2 });
        if (checkResult === null) return;

        const checkResponse = checkResult.trim().replace(/^Option\s*[AB]:\s*/i, '');
        const isFinished = checkResponse.toLowerCase().replace(/[^a-z]/g, '') === 'finished';

        const sentence = await generate(
            [{ role: 'system', content: system }, { role: 'user', content: `Continue writing. ${text} ` }],
            { maxTokens: options.continuationTokens, temperature: options.temperature });
        if (sentence === null) return;

        const result = isFinished
            ? ' ' + trimLeading(trimTrailing(sentence))
            : trimLeading(trimTrailing(sentence));
        if (!result.trim()) return;
        yield { text: result };
    }

    private getPreCursorText(editor: Editor): string {
        const cursor = editor.getCursor();
        return editor.getRange({ line: 0, ch: 0 }, cursor);
    }

    private buildSystemPrompt(options: ProfileOptions): string {
        const file = this.app.workspace.getActiveFile();
        if (!file) return options.systemPrompt;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm) return options.systemPrompt;

        // Full per-document override: `ai-prompt:` frontmatter replaces the
        // profile system prompt for this note entirely.
        const custom = fm["ai-prompt"];
        if (typeof custom === "string" && custom.trim()) {
            return custom.trim();
        }

        // Per-document context: `ai-context:` frontmatter is appended to the
        // profile system prompt.
        if (options.aiContext) {
            const ctx = fm["ai-context"];
            if (typeof ctx === "string" && ctx.trim()) {
                return options.systemPrompt + "\n\nDOCUMENT CONTEXT: " + ctx.trim();
            }
        }

        return options.systemPrompt;
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
