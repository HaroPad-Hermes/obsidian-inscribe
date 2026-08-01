import { App, MarkdownView, Modal, Notice, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import CompletionService from "src/completions/service";
import { REWRITE_PRESETS } from "src/completions/rewrite";
import { setDiffEffect } from "src/extension/diff";

export class RewriteModal extends Modal {
    private service: CompletionService;
    private preset: string = REWRITE_PRESETS[0].id;
    private custom: string = "";
    private thinking: boolean = true;

    constructor(app: App, service: CompletionService) {
        super(app);
        this.service = service;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Edit selection" });

        new Setting(contentEl)
            .setName("Operation")
            .addDropdown((dd) => {
                for (const p of REWRITE_PRESETS) dd.addOption(p.id, p.label);
                dd.addOption("custom", "Custom instruction…");
                dd.setValue(this.preset);
                dd.onChange((v) => { this.preset = v; });
            });

        new Setting(contentEl)
            .setName("Custom instruction")
            .setDesc("Appended to the selected operation, or used alone with 'Custom instruction…'.")
            .addTextArea((ta) => {
                ta.inputEl.rows = 3;
                ta.onChange((v) => { this.custom = v; });
            });

        new Setting(contentEl)
            .setName("Thinking")
            .setDesc("Let the model reason before rewriting — slower, but often better for shorten/expand/formal.")
            .addToggle((t) => t.setValue(this.thinking).onChange((v) => { this.thinking = v; }));

        new Setting(contentEl)
            .addButton((btn) => {
                btn.setButtonText("Rewrite").setCta();
                btn.onClick(() => this.run(btn));
            })
            .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
    }

    private async run(runBtn: { setButtonText: (t: string) => void; setDisabled: (d: boolean) => void }) {
        const preset = REWRITE_PRESETS.find((p) => p.id === this.preset);
        const instruction = (this.preset === "custom" ? this.custom : (preset?.instruction ?? "") + (this.custom ? ` ${this.custom}` : "")).trim();
        if (!instruction) {
            new Notice("Enter an instruction");
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
            const session = await this.service.rewriteSelection(instruction, this.thinking);
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
            runBtn.setButtonText("Rewrite");
            runBtn.setDisabled(false);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
