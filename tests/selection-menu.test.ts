import { describe, it, expect } from "vitest";
import { computeMenuPosition } from "../src/extension/selection-menu";

const viewport = { width: 1920, height: 1080 };
const menu = { width: 260, height: 34 };

describe("computeMenuPosition", () => {
    it("pins the left corner to the leftmost point of the text field", () => {
        const { left } = computeMenuPosition({ top: 300, bottom: 320 }, menu, viewport, 300);
        expect(left).toBe(308); // contentLeft + 8
    });

    it("places the menu below the selection's bottom edge", () => {
        const { top } = computeMenuPosition({ top: 300, bottom: 320 }, menu, viewport, 300);
        expect(top).toBe(326); // bottom + 6
    });

    it("flips above the selection when the menu would overflow the bottom", () => {
        const { top } = computeMenuPosition({ top: 1050, bottom: 1070 }, menu, viewport, 300);
        expect(top).toBe(1010); // anchor.top - menu.height - 6
    });

    it("uses the last line's bottom for multi-line selections", () => {
        const { top } = computeMenuPosition({ top: 300, bottom: 700 }, menu, viewport, 300);
        expect(top).toBe(706);
    });
});
