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
    // Per-call thinking override (OpenAI-compatible providers): "disabled"
    // forces thinking:{type:"disabled"}; "enabled" forces it on; omitted
    // falls back to the provider's disableThinking setting.
    thinking?: "disabled" | "enabled";
}

// Completer interface for ai integrations
export interface Provider {
    settings: any
    generate: (editor: Editor, prompt: string, options: ProfileOptions) => AsyncGenerator<string>;
    // Optional non-streaming single call — used by the two-prompt (plate-mode) flow.
    // Providers without it fall back to the streaming path.
    generateOnce?: (messages: ChatMessage[], opts: GenerateOnceOptions) => Promise<string>;
    // Streaming single call — yields the accumulated text as chunks arrive so
    // the caller can render the output incrementally (generate flows).
    streamOnce?: (messages: ChatMessage[], opts: GenerateOnceOptions, signal?: AbortSignal) => AsyncGenerator<string>;
    // FIM (fill-in-the-middle): raw completion with a suffix anchor. Providers
    // that expose a suffix-FIM endpoint (e.g. DeepSeek /beta/completions) use
    // this for continuations; others fall back to the chat path.
    generateFimOnce?: (prompt: string, suffix: string, opts: GenerateOnceOptions) => Promise<string>;
    abort: () => Promise<void>;
    fetchModels(): Promise<string[]> | string[];
    connectionTest(): Promise<boolean>;
}
