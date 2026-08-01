import { Provider, ChatMessage, GenerateOnceOptions } from "..";
import { Editor } from "obsidian";
import { OpenAICompatibleSettings } from ".";
import { ProfileOptions } from "src/settings/settings";
import OpenAI from "openai";

// The FIM endpoint is a sibling of the versioned chat base: strip a trailing
// /v\d+ (and any slash) and append /beta/completions.
export function fimEndpoint(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "")}/beta/completions`;
}

export class OpenAICompatibleProvider implements Provider {
    client: OpenAI;
    settings: OpenAICompatibleSettings;
    aborted: boolean = false;
    abortcontroller?: AbortController;

    constructor(settings: OpenAICompatibleSettings) {
        this.settings = settings;
        this.client = new OpenAI({
            baseURL: this.settings.baseUrl,
            apiKey: this.settings.apiKey,
            dangerouslyAllowBrowser: true,
        });
    }

    private buildExtraParams(thinkingOverride?: "disabled" | "enabled"): Record<string, unknown> {
        const extra: Record<string, unknown> = { ...this.settings.extraParams };
        const thinking = thinkingOverride ?? (this.settings.disableThinking ? "disabled" : undefined);
        if (thinking) {
            extra.thinking = { type: thinking };
        }
        return extra;
    }

    async *generate(editor: Editor, prompt: string, options: ProfileOptions): AsyncGenerator<string> {
        this.aborted = false;
        const abortcontroller = new AbortController();
        this.abortcontroller = abortcontroller;

        const initialPosition = editor.getCursor();
        const stream = await this.client.chat.completions.create({
            model: options.model,
            messages: [
                { role: "system", content: options.systemPrompt },
                { role: "user", content: prompt }
            ],
            temperature: options.temperature,
            stream: true,
            ...this.buildExtraParams(),
        }, { signal: abortcontroller.signal });

        let completion = "";
        for await (const chunk of stream) {
            if (this.aborted) {
                return;
            }
            if (this.cursorMoved(editor, initialPosition)) {
                this.abort();
                return;
            }

            const content = chunk.choices[0]?.delta?.content || "";
            completion += content;
            yield completion;
        }
    }

    async generateOnce(messages: ChatMessage[], opts: GenerateOnceOptions): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: opts.model,
            messages: messages,
            temperature: opts.temperature,
            max_tokens: opts.maxTokens,
            stream: false,
            ...this.buildExtraParams(opts.thinking),
        });
        return response.choices[0]?.message?.content || "";
    }

    // FIM: raw completion against {base}/beta/completions (sibling of /v1),
    // with the post-cursor text as a positional anchor. The model writes the
    // middle between prompt and suffix.
    async generateFimOnce(prompt: string, suffix: string, opts: GenerateOnceOptions): Promise<string> {
        const url = fimEndpoint(this.settings.baseUrl);
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.settings.apiKey}`,
            },
            body: JSON.stringify({
                model: opts.model,
                prompt,
                suffix,
                max_tokens: opts.maxTokens ?? 40,
                temperature: opts.temperature ?? 0.5,
                stream: false,
            }),
        });
        if (!response.ok) {
            throw new Error(`FIM request failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
        }
        const data = (await response.json()) as { choices?: Array<{ text?: string }> };
        return data.choices?.[0]?.text ?? "";
    }

    async abort() {
        if (this.aborted) return;
        this.aborted = true;
        this.abortcontroller?.abort();
    }

    async fetchModels(): Promise<string[]> {
        if (!this.client) {
            return this.settings.models;
        }

        const models = await this.client.models.list();
        return models.data.map(model => model.id);
    }

    async connectionTest(): Promise<boolean> {
        try {
            await this.client.models.list();
            return true;
        } catch (error) {
            console.error("Error testing connection:", error);
            return false;
        }
    }

    private cursorMoved(editor: Editor, initialPosition: { line: number, ch: number }): boolean {
        const currentPosition = editor.getCursor();
        return currentPosition.line !== initialPosition.line || currentPosition.ch !== initialPosition.ch;
    }
}

// Import this at the end to avoid circular dependency issues
import preparePrompt from "src/completions/prompt";
