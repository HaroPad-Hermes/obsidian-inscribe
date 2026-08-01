import { describe, it, expect } from "vitest";
import { computeMenuPosition, selectionMenuLeft } from "../src/extension/selection-menu";

const viewport = { width: 1920, height: 1080 };
const menu = { width: 260, height: 34 };

describe("selectionMenuLeft", () => {
    it("hugs the leftmost highlighted character for single-line selections", () => {
        expect(selectionMenuLeft(200, 300, false)).toBe(200);
    });

    it("pins to the text field's left edge for multi-line selections", () => {
        expect(selectionMenuLeft(200, 300, true)).toBe(308); // contentLeft + 8
    });

    it("clamps single-line anchors to 8px near the left border", () => {
        expect(selectionMenuLeft(-40, 300, false)).toBe(8);
    });
});

describe("computeMenuPosition", () => {
    it("places the menu's left corner at the resolved anchor", () => {
        const { left } = computeMenuPosition({ left: 200, top: 300, bottom: 320 }, menu, viewport);
        expect(left).toBe(200);
    });

    it("places the menu below the selection's bottom edge", () => {
        const { top } = computeMenuPosition({ left: 200, top: 300, bottom: 320 }, menu, viewport);
        expect(top).toBe(326); // bottom + 6
    });

    it("flips above the selection when the menu would overflow the bottom", () => {
        const { top } = computeMenuPosition({ left: 200, top: 1050, bottom: 1070 }, menu, viewport);
        expect(top).toBe(1010); // anchor.top - menu.height - 6
    });
});
