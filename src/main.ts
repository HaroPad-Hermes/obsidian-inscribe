import { MarkdownView, Notice, Plugin } from 'obsidian';
import { inlineSuggestions } from "./extension";
import { diffSessionState } from "./extension/diff";
import { Settings, DEFAULT_SETTINGS } from './settings/settings';
import InscribeSettingsTab from './settings/tab';
import { ProviderFactory } from './providers/factory';
import { ProfileService } from './profile/service';
import CompletionService from './completions/service';
import StatusBarItem from './statusbar/statusbar';
import { PromptModal } from './settings/prompt-modal';
import { RewriteModal } from './settings/rewrite-modal';
import { deepMerge } from './settings/load';

export default class Inscribe extends Plugin {
	settings!: Settings;
	providerFactory!: ProviderFactory;
	statusBarItem!: StatusBarItem;

	private profileService!: ProfileService;
	private completionService!: CompletionService;

	async onload() {
		await this.loadSettings();

		this.profileService = new ProfileService(this);
		this.providerFactory = new ProviderFactory(this);
		this.completionService = new CompletionService(this.app, this.settings, this.profileService, this.providerFactory);
		this.statusBarItem = new StatusBarItem(this, this.profileService, this.completionService);

		this.addSettingTab(new InscribeSettingsTab(this));

		this.addCommand({
			id: "edit-document-prompt",
			name: "Edit document prompt",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") {
					new Notice("Open a markdown note first");
					return;
				}
				new PromptModal(this.app, file).open();
			},
		});

		this.addCommand({
			id: "edit-selection",
			name: "Edit selection (AI rewrite)",
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || view.editor.getSelection().length === 0) {
					new Notice("Select some text first");
					return;
				}
				new RewriteModal(this.app, this.completionService).open();
			},
		});

		await this.setupExtension();
	}

	async setupExtension() {
		const extension = inlineSuggestions({
			fetchFunc: () => this.completionService.fetchCompletion(),
			getOptions: () => this.profileService.getOptions(),
			acceptanceHotkey: this.settings.suggestionControl.acceptanceHotkey,
			triggerHotkey: this.settings.suggestionControl.manualActivationKey,
		});
		this.registerEditorExtension([extension, diffSessionState]);
	}

	async loadSettings() {
		const loadedSettings = await this.loadData() || {};

		this.settings = deepMerge(
			DEFAULT_SETTINGS,
			loadedSettings
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.providerFactory.rebuildProviders();
	}
}
