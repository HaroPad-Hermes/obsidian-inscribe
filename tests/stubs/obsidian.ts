// Minimal stubs so vitest can import modules that reference the Obsidian API.
export const setIcon = () => {};
export const setTooltip = () => {};
export class Notice {
    constructor(_message: string) {}
}
export class Component {
    load() {}
    onload() {}
    register() {}
    unload() {}
    registerEvent() {}
    registerDomEvent() {}
    registerInterval() {}
    addChild() {}
    removeChild() {}
    children: unknown[] = [];
}
export const MarkdownRenderer = {
    renderMarkdown: async (_markdown: string, el: HTMLElement, _sourcePath: string, _component: unknown) => {
        el.textContent = _markdown;
    },
};
