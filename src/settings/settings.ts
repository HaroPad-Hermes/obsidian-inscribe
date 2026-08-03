import { ProviderType } from "src/providers";
import { SplitStrategy } from "src/extension";
import { OllamaSettings } from "src/providers/ollama";
import { OpenAISettings } from "src/providers/openai";
import { OpenAICompatibleSettings } from "src/providers/openai-compat";
import { GeminiSettings } from "src/providers/gemini";
import { GrokSettings } from "src/providers/grok";

// Completion options for a profile
export interface ProfileOptions {
    model: string,
    userPrompt: string,
    systemPrompt: string,
    temperature: number,
    // Plate-mode options (two-prompt flow)
    twoPromptFlow: boolean,
    wordCheckTokens: number,
    continuationTokens: number,
    // Append the `ai-context` frontmatter property to the system prompt
    aiContext: boolean,
}

// Profile settings
export interface Profile {
    name: string,
    provider: ProviderType,
    completionOptions: ProfileOptions,
}

export type ProfileId = string;
export type Profiles = Record<ProfileId, Profile>
export type Path = string;
export type PathConfig = { profile: ProfileId, enabled: boolean };
export type SelectionMenuPlacement = "smart" | "centered" | "first";
export type SelectionMenuSide = "below" | "above";

export type SuggestionControl = {
    // One-click plate-editor-style setup (Tab dual-role + word split)
    plateMode: boolean,
    acceptanceHotkey: string,
    manualActivationKey?: string,
    splitStrategy: SplitStrategy,
    delayMs: number,
    // Selection quick-menu placement: "smart" (first char on one line, text
    // field edge on multi-line), "centered" (selection midpoint), "first"
    // (always the first highlighted character).
    selectionMenuPlacement: SelectionMenuPlacement,
    // Selection quick-menu side: "below" (under the selection, flips above on
    // overflow) or "above" (over the selection, flips below on overflow).
    selectionMenuSide: SelectionMenuSide,
    // Soft pull-in: shift the menu left by half the overflow when it would
    // stick out past the text field's right edge.
    selectionMenuPullIn: boolean,
    outputLimit: {
        enabled: boolean,
        sentences: number,
    },
    // Rules that determine when suggestions should auto-trigger
    activationRules: {
        // Require the current line to be non-empty
        requireNonEmptyLine: boolean,
        // Disallow triggering at column 0 (line start)
        requireCursorNotAtStart: boolean,
        // Require a space character immediately before the cursor
        requireSpaceBeforeCursor: boolean,
    },
}

export interface Settings {
    enabled: boolean,
    // settings for controlling suggestions
    suggestionControl: SuggestionControl,
    // available providers
    providers: {
        ollama: OllamaSettings,
        openai: OpenAISettings,
        openai_compatible: OpenAICompatibleSettings,
        gemini: GeminiSettings,
        grok: GrokSettings,
    },
    // profiles
    profiles: Profiles,
    // path to profile mappings
    path_configs: Record<Path, PathConfig>,
}

export const DEFAULT_PROFILE: ProfileId = "default";
export const DEFAULT_PATH = "/";
export const DEFAULT_SETTINGS: Settings = {
    enabled: false,
    suggestionControl: {
        plateMode: false,
        acceptanceHotkey: "Tab",
        splitStrategy: "sentence",
        manualActivationKey: "",
        selectionMenuPlacement: "smart",
        selectionMenuSide: "below",
        selectionMenuPullIn: true,
        outputLimit: {
            enabled: true,
            sentences: 1,
        },
        delayMs: 500,
        activationRules: {
            requireNonEmptyLine: true,
            requireCursorNotAtStart: true,
            requireSpaceBeforeCursor: true,
        },
    },
    providers: {
        openai: {
            integration: ProviderType.OPENAI,
            name: "Open AI",
            description: "Use OpenAI APIs to generate text.",
            apiKey: "api-key",
            models: ["gpt-5", "gpt-5-nano"],
            configured: false,
            temperature_range: { min: 1, max: 1 },
        },
        ollama: {
            integration: ProviderType.OLLAMA,
            name: "Ollama",
            description: "Use your own Ollama instance to generate text.",
            host: "http://localhost:11434",
            models: ["llama3.2:latest", "mistral-nemo"],
            configured: false,
            temperature_range: { min: 0, max: 1 },
        },
        openai_compatible: {
            integration: ProviderType.OPENAI_COMPATIBLE,
            name: "OpenAI compatible",
            description: "Use OpenAI compatible APIs to generate completions.",
            apiKey: "",
            baseUrl: "https://api.deepseek.com/v1",
            models: ["deepseek-v4-flash", "gpt-4o", "gpt-4o-mini"],
            configured: false,
            temperature_range: { min: 0, max: 1 },
            extraParams: {},
            disableThinking: false,
        },
        gemini: {
            integration: ProviderType.GEMINI,
            name: "Gemini",
            description: "Use Gemini APIs to generate text.",
            apiKey: "api-key",
            models: [
                "gemini-2.0-flash",
                "gemini-2.0-flash-lite",
            ],
            configured: false,
            temperature_range: { min: 0, max: 2 },
        },
        grok: {
            integration: ProviderType.GROK,
            name: "Grok",
            description: "Use xAI Grok models to generate text.",
            apiKey: "api-key",
            models: ["grok-3-mini", "grok-3"],
            configured: false,
            temperature_range: { min: 0, max: 1 },
        },
    },
    profiles: {
        default: {
            name: "Default profile",
            provider: ProviderType.OPENAI_COMPATIBLE,
            completionOptions: {
                model: "deepseek-v4-flash",
                userPrompt: 'If the last sentence is incomplete, only complete the sentence and nothing else. If the last sentence is complete, generate a new sentence that follows logically:\n---\n{{{pre_cursor}}}',
                systemPrompt: "You are an AI autocomplete engine. Output only the continuation text. No explanations, no meta-text. Never repeat words already in the text. If you cannot continue meaningfully, output nothing. Continue ONLY the very last word or sentence at the end of the text. Never complete or re-emit earlier sentences, list items, or text that already exists above. Write in Markdown, matching the surrounding structure — always start a new line after a heading (## ...) before body text.",
                temperature: 0.5,
                twoPromptFlow: true,
                wordCheckTokens: 5,
                continuationTokens: 40,
                aiContext: true,
            }
        },
    },
    path_configs: {
        "/": {
            profile: DEFAULT_PROFILE,
            enabled: true,
        },
    },
};

// Create a new profile and return the id
export function createProfile(settings: Settings): string {
    const profiles = settings.profiles;
    const id = Math.random().toString(36).substring(2, 6);

    // generate a new profile name
    let name = "New profile";
    // loop through the profiles to make sure the name is unique
    let i = 1;
    Object.entries(profiles).forEach(([, value]) => {
        if (value.name === name) {
            name = `New profile ${i}`;
            i++;
        }
    });

    // copy the default profile
    const defaultProfile = profiles[DEFAULT_PROFILE];
    const profile = {
        ...defaultProfile,
        name: name,
    };

    // add the new profile
    profiles[id] = profile;

    return id;
}

export function findPathConfig(settings: Settings, path: string): PathConfig {
    return settings.path_configs[path] || settings.path_configs[DEFAULT_PATH];
}

export function createPathConfig(settings: Settings, path: string, profile: ProfileId): void {
    path = path || DEFAULT_PATH;
    settings.path_configs[path] = { profile: profile, enabled: true };
}

export function resetSettings(settings: Settings): void {
    Object.assign(settings, DEFAULT_SETTINGS);
}

export const isDefaultProfile = (profile: ProfileId): boolean => {
    return profile === DEFAULT_PROFILE;
}
