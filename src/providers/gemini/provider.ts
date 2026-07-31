import { GeminiSettings } from "./settings";
import { Provider, ChatMessage, GenerateOnceOptions } from "..";
import { Editor } from "obsidian";
import { ProfileOptions } from "src/settings/settings";
import { GoogleGenAI } from "@google/genai";

export class GeminiProvider implements Provider {
    client: GoogleGenAI;
    settings: GeminiSettings;
    aborted: boolean = false;

    constructor(settings: GeminiSettings) {
        this.settings = settings;
        this.client = new GoogleGenAI({
            apiKey: settings.apiKey,
        });
    }

    async * generate(editor: Editor, prompt: string, options: ProfileOptions): AsyncGenerator<string> {
        this.aborted = false;

        const response = await this.client.models.generateContentStream({
            model: options.model,
            contents: prompt,
            config: {
                temperature: options.temperature,
                systemInstruction: options.systemPrompt,
            }
        });

        const initialPosition = editor.getCursor();
        let completion = "";
        for await (let chunk of response) {
            if (this.aborted) {
                return;
            }
            if (this.cursorMoved(editor, initialPosition)) {
                this.abort();
                return;
            }
            completion += chunk.text
            yield completion;
        }
    }

    async generateOnce(messages: ChatMessage[], opts: GenerateOnceOptions): Promise<string> {
        const system = messages.find(m => m.role === "system")?.content;
        const user = messages.filter(m => m.role === "user").map(m => m.content).join("\n");
        const response = await this.client.models.generateContent({
            model: opts.model,
            contents: user,
            config: {
                temperature: opts.temperature,
                maxOutputTokens: opts.maxTokens,
                systemInstruction: system,
            },
        });
        return response.text || "";
    }

    private cursorMoved(editor: Editor, initialPosition: { line: number, ch: number }): boolean {
        const currentPosition = editor.getCursor();
        return currentPosition.line !== initialPosition.line || currentPosition.ch !== initialPosition.ch;
    }

    async abort() {
        if (this.aborted) return;
        this.aborted = true;
    }

    async fetchModels(): Promise<string[]> {
        const models = (await this.client.models.list()).page;

        return models
            .map(model => model.name?.replace("models/", ""))
            .filter((name): name is string => typeof name === "string");
    }

    async connectionTest(): Promise<boolean> {
        try {
            await this.client.caches.list();
            return true;
        } catch (error) {
            console.error("Error testing connection:", error);
            return false;
        }
    }
}


