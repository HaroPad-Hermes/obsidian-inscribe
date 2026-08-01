import { describe, it, expect } from "vitest";
import { computeMenuPosition } from "../src/extension/selection-menu";

const viewport = { width: 1920, height: 1080 };

describe("computeMenuPosition", () => {
    it("places the menu below the selection anchor by default", () => {
        const { left, top } = computeMenuPosition({ left: 200, top: 300, bottom: 320 }, 34, viewport);
        expect(top).toBe(326); // bottom + 6
        expect(left).toBe(200);
    });

    it("flips above the anchor when the menu would overflow the bottom", () => {
        const { top } = computeMenuPosition({ left: 200, top: 1050, bottom: 1070 }, 34, viewport);
        expect(top).toBe(1044); // anchor.top - height - 6
    });

    it("clamps the left edge to 8px for selections near the left border", () => {
        const { left } = computeMenuPosition({ left: -40, top: 100, bottom: 120 }, 34, viewport);
        expect(left).toBe(8);
    });

    it("clamps the left edge so the menu stays on screen for wide selections", () => {
        const { left } = computeMenuPosition({ left: 1900, top: 100, bottom: 120 }, 34, viewport);
        expect(left).toBeLessThanOrEqual(viewport.width - 260);
    });
});
