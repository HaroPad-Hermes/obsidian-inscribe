import { App, Modal, Notice, Setting, TFile } from "obsidian";

// Modal for editing per-document AI prompts (`ai-prompt` override and
// `ai-context` note) in the active note's frontmatter.
export class PromptModal extends Modal {
    private file: TFile;
    private aiPrompt = "";
    private aiContext = "";

    constructor(app: App, file: TFile) {
        super(app);
        this.file = file;
        const fm = app.metadataCache.getFileCache(file)?.frontmatter;
        if (fm) {
            this.aiPrompt = typeof fm["ai-prompt"] === "string" ? fm["ai-prompt"] : "";
            this.aiContext = typeof fm["ai-context"] === "string" ? fm["ai-context"] : "";
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.titleEl.setText(`Document prompt — ${this.file.basename}`);

        new Setting(contentEl)
            .setName("System prompt override")
            .setDesc("Stored as `ai-prompt` in frontmatter. Replaces the profile prompt for this note; the autocomplete contract (no meta-text, never repeat words) is appended automatically. Leave empty for none.")
            .addTextArea((ta) => {
                ta.inputEl.rows = 6;
                ta.setValue(this.aiPrompt);
                ta.onChange((v) => { this.aiPrompt = v; });
            });

        new Setting(contentEl)
            .setName("Context note")
            .setDesc("Stored as `ai-context` in frontmatter. Appended to the system prompt as DOCUMENT CONTEXT. Leave empty for none.")
            .addTextArea((ta) => {
                ta.inputEl.rows = 3;
                ta.setValue(this.aiContext);
                ta.onChange((v) => { this.aiContext = v; });
            });

        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText("Save").setCta().onClick(() => this.save()))
            .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
    }

    async save() {
        const prompt = this.aiPrompt.trim();
        const ctx = this.aiContext.trim();
        await this.app.fileManager.processFrontMatter(this.file, (fm) => {
            if (prompt) {
                fm["ai-prompt"] = prompt;
            } else {
                delete fm["ai-prompt"];
            }
            if (ctx) {
                fm["ai-context"] = ctx;
            } else {
                delete fm["ai-context"];
            }
        });
        new Notice(`Document prompt updated for ${this.file.basename}`);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}
