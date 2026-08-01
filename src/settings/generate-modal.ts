import { App, MarkdownView, Modal, Notice, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import CompletionService from "src/completions/service";
import { setDiffEffect } from "src/extension/diff";

// "Generate with AI": write new text from scratch at the cursor. A large,
// wrapping textarea takes the prompt; the result lands in the inline diff
// (Accept/Discard), inserting at the cursor position.
export class GenerateModal extends Modal {
    private service: CompletionService;
    private instruction: string = "";
    private thinking: boolean = true;

    constructor(app: App, service: CompletionService) {
        super(app);
        this.service = service;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Generate with AI" });

        new Setting(contentEl)
            .setName("Prompt")
            .setDesc("Describe what to write. The surrounding document is sent as context.")
            .addTextArea((ta) => {
                ta.inputEl.rows = 8;
                ta.inputEl.className = "inscribe-generate-input";
                ta.setPlaceholder("e.g. Write an introduction paragraph about the water cycle…");
                ta.onChange((v) => { this.instruction = v; });
            });

        new Setting(contentEl)
            .setName("Thinking")
            .setDesc("Let the model reason before writing — slower, often better for longer text.")
            .addToggle((t) => t.setValue(this.thinking).onChange((v) => { this.thinking = v; }));

        new Setting(contentEl)
            .addButton((btn) => {
                btn.setButtonText("Generate").setCta();
                btn.onClick(() => this.run(btn));
            })
            .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
    }

    private async run(runBtn: { setButtonText: (t: string) => void; setDisabled: (d: boolean) => void }) {
        const instruction = this.instruction.trim();
        if (!instruction) {
            new Notice("Enter a prompt");
            return;
        }
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
            new Notice("Open a markdown note first");
            return;
        }

        runBtn.setButtonText("Working…");
        runBtn.setDisabled(true);
        try {
            const session = await this.service.generateText(instruction, this.thinking);
            if (session) {
                const cm = (view.editor as unknown as { cm?: EditorView }).cm;
                if (cm) {
                    cm.dispatch({ effects: setDiffEffect.of(session) });
                    this.close();
                    return;
                }
                new Notice("Inscribe: could not attach the diff view");
            }
        } finally {
            runBtn.setButtonText("Generate");
            runBtn.setDisabled(false);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
