import { describe, it, expect } from "vitest";
import { computeMenuPosition } from "../src/extension/selection-menu";

const viewport = { width: 1920, height: 1080 };
const menu = { width: 260, height: 34 };

describe("computeMenuPosition", () => {
    it("places the menu's left corner at the selection's leftmost edge", () => {
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

    it("clamps the left edge to 8px near the left border", () => {
        const { left } = computeMenuPosition({ left: -40, top: 100, bottom: 120 }, menu, viewport);
        expect(left).toBe(8);
    });
});
