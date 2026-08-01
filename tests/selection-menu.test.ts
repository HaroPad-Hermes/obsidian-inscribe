import { describe, it, expect } from "vitest";
import { computeMenuPosition } from "../src/extension/selection-menu";

const viewport = { width: 1920, height: 1080 };
const menu = { width: 260, height: 34 };

describe("computeMenuPosition", () => {
    it("centers the menu on the selection midpoint, below its bottom", () => {
        // selection spans x=200..800 -> midX = 500; bottom = 320
        const { left, top } = computeMenuPosition({ midX: 500, top: 300, bottom: 320 }, menu, viewport);
        expect(left).toBe(370); // 500 - 260/2
        expect(top).toBe(326); // bottom + 6
    });

    it("flips above the anchor when the menu would overflow the bottom", () => {
        const { top } = computeMenuPosition({ midX: 500, top: 1050, bottom: 1070 }, menu, viewport);
        expect(top).toBe(1010); // anchor.top - menu.height - 6
    });

    it("clamps to the left edge for selections near the left border", () => {
        // midX=40 -> 40 - 130 = -90 -> clamped to 8
        const { left } = computeMenuPosition({ midX: 40, top: 100, bottom: 120 }, menu, viewport);
        expect(left).toBe(8);
    });

    it("clamps so the menu stays on screen for selections near the right border", () => {
        // midX=1900 -> 1900 - 130 = 1770 -> clamped to 1920 - 260 - 8 = 1652
        const { left } = computeMenuPosition({ midX: 1900, top: 100, bottom: 120 }, menu, viewport);
        expect(left).toBe(1652);
    });
});
