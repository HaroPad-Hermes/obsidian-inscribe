import { Editor } from "obsidian";
import { ProfileOptions } from "src/settings/settings";

export enum ProviderType {
    OLLAMA = "ollama",
    OPENAI = "openai",
    OPENAI_COMPATIBLE = "openai_compatible",
    GEMINI = "gemini",
    GROK = "grok",
}

// Message for a one-shot (non-streaming) completion call
export interface ChatMessage {
    role: "system" | "user";
    content: string;
}

export interface GenerateOnceOptions {
    model: string;
    maxTokens?: number;
    temperature?: number;
}

// Completer interface for ai integrations
export interface Provider {
    settings: any
    generate: (editor: Editor, prompt: string, options: ProfileOptions) => AsyncGenerator<string>;
    // Optional non-streaming single call — used by the two-prompt (plate-mode) flow.
    // Providers without it fall back to the streaming path.
    generateOnce?: (messages: ChatMessage[], opts: GenerateOnceOptions) => Promise<string>;
    abort: () => Promise<void>;
    fetchModels(): Promise<string[]> | string[];
    connectionTest(): Promise<boolean>;
}
