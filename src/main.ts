import { MarkdownView, Notice, Plugin } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { inlineSuggestions } from "./extension";
import { diffSessionState, setDiffEffect } from "./extension/diff";
import { selectionMenuPlugin } from "./extension/selection-menu";
import { Settings, DEFAULT_SETTINGS } from './settings/settings';
import InscribeSettingsTab from './settings/tab';
import { ProviderFactory } from './providers/factory';
import { ProfileService } from './profile/service';
import CompletionService from './completions/service';
import StatusBarItem from './statusbar/statusbar';
import { PromptModal } from './settings/prompt-modal';
import { RewriteModal } from './settings/rewrite-modal';
import { GenerateModal } from './settings/generate-modal';
import { deepMerge } from './settings/load';
import { ArbiterServerManager } from './server-manager';
import { join } from 'path';

export default class Inscribe extends Plugin {
	settings!: Settings;
	providerFactory!: ProviderFactory;
	statusBarItem!: StatusBarItem;

	private profileService!: ProfileService;
	private completionService!: CompletionService;
	private arbiterServer = new ArbiterServerManager();

	// (Re)start or stop the bundled llama-server per the arbiter settings.
	// Called on load and whenever the user toggles manageServer / edits the
	// model file. Safe to call repeatedly — the manager no-ops when the
	// server is already healthy or management is disabled.
	refreshArbiterServer() {
		const a = this.settings.arbiter;
		if (a.manageServer) {
			this.arbiterServer.ensureRunning({
				manageServer: true,
				baseUrl: a.baseUrl,
				modelFile: a.modelFile,
				serverDir: this.manifest.dir ?? join(this.manifest.basePath, this.manifest.id, 'server'),
			}).catch((e) => console.error("Inscribe: arbiter server start failed", e));
		} else {
			this.arbiterServer.stop();
		}
	}

	async onload() {
		await this.loadSettings();

		this.profileService = new ProfileService(this);
		this.providerFactory = new ProviderFactory(this);
		this.completionService = new CompletionService(this.app, this.settings, this.profileService, this.providerFactory);
		this.statusBarItem = new StatusBarItem(this, this.profileService, this.completionService);

		this.addSettingTab(new InscribeSettingsTab(this));

		// Spawn the local spacing-arbiter server (if managed + not already up).
		this.refreshArbiterServer();

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

		this.addCommand({
			id: "generate-text",
			name: "Generate text with AI",
			callback: () => {
				new GenerateModal(this.app, this.completionService).open();
			},
		});

		// Hook the native editor context menu (right-click in a note).
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu) => {
				menu.addItem((item) => {
					item.setTitle("Generate with AI…")
						.setIcon("sparkles")
						.onClick(() => {
							new GenerateModal(this.app, this.completionService).open();
						});
				});
			})
		);

		await this.setupExtension();
	}

	async setupExtension() {
		const extension = inlineSuggestions({
			fetchFunc: () => this.completionService.fetchCompletion(),
			getOptions: () => this.profileService.getOptions(),
			acceptanceHotkey: this.settings.suggestionControl.acceptanceHotkey,
			triggerHotkey: this.settings.suggestionControl.manualActivationKey,
		});
		const selectionMenu = selectionMenuPlugin(
			async (instruction, thinking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				const session = await this.completionService.rewriteSelection(instruction, thinking);
				if (!session) return false;
				const cm = (view.editor as unknown as { cm?: EditorView }).cm;
				if (!cm) return false;
				cm.dispatch({ effects: setDiffEffect.of(session) });
				return true;
			},
			() => this.settings.suggestionControl.selectionMenuPlacement,
			() => this.settings.suggestionControl.selectionMenuSide,
			() => this.settings.suggestionControl.selectionMenuPullIn
		);
		this.registerEditorExtension([extension, diffSessionState, selectionMenu]);
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

	onunload() {
		this.arbiterServer.stop();
	}
}
