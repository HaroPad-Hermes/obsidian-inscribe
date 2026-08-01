import { describe, it, expect } from "vitest";
import { computeMenuPosition, resolveMenuLeft } from "../src/extension/selection-menu";

const viewport = { width: 1920, height: 1080 };
const menu = { width: 260, height: 34 };

describe("resolveMenuLeft", () => {
    it("smart: hugs the leftmost highlighted character on one line", () => {
        expect(resolveMenuLeft("smart", 200, 300, false, 500, 260, 1920)).toBe(200);
    });

    it("smart: pins to the text field's left edge on multi-line selections", () => {
        expect(resolveMenuLeft("smart", 200, 300, true, 500, 260, 1920)).toBe(300);
    });

    it("first: always hugs the leftmost highlighted character, even multi-line", () => {
        expect(resolveMenuLeft("first", 200, 300, true, 500, 260, 1920)).toBe(200);
    });

    it("centered: centers on the selection midpoint", () => {
        // midX 500, width 260 -> 500 - 130 = 370
        expect(resolveMenuLeft("centered", 200, 300, false, 500, 260, 1920)).toBe(370);
    });

    it("centered: clamps near the left border", () => {
        expect(resolveMenuLeft("centered", 200, 300, false, 40, 260, 1920)).toBe(8);
    });

    it("centered: clamps near the right border", () => {
        // 1900 - 130 = 1770 -> clamp to 1920 - 260 - 8 = 1652
        expect(resolveMenuLeft("centered", 200, 300, false, 1900, 260, 1920)).toBe(1652);
    });
});

describe("computeMenuPosition", () => {
    it("below: places the menu below the selection's bottom edge", () => {
        const { top } = computeMenuPosition({ left: 200, top: 300, bottom: 320 }, menu, viewport, "below", 1200, true);
        expect(top).toBe(326); // bottom + 6
    });

    it("below: flips above the selection when the menu would overflow the bottom", () => {
        const { top } = computeMenuPosition({ left: 200, top: 1050, bottom: 1070 }, menu, viewport, "below", 1200, true);
        expect(top).toBe(1010); // anchor.top - menu.height - 6
    });

    it("above: places the menu above the selection's top edge", () => {
        const { top } = computeMenuPosition({ left: 200, top: 300, bottom: 320 }, menu, viewport, "above", 1200, true);
        expect(top).toBe(260); // anchor.top - menu.height - 6
    });

    it("above: flips below when the menu would overflow the top", () => {
        const { top } = computeMenuPosition({ left: 200, top: 20, bottom: 40 }, menu, viewport, "above", 1200, true);
        expect(top).toBe(46); // bottom + 6
    });

    it("soft pull-in: shifts left by half the overflow past the text field's right edge", () => {
        // left 900 + width 260 = 1160 vs contentRight 1000 -> overflow 160
        // -> left = 900 - 80 = 820
        const { left } = computeMenuPosition({ left: 900, top: 300, bottom: 320 }, menu, viewport, "below", 1000, true);
        expect(left).toBe(820);
    });

    it("pull-in disabled: anchor stays put even past the text field's right edge", () => {
        const { left } = computeMenuPosition({ left: 900, top: 300, bottom: 320 }, menu, viewport, "below", 1000, false);
        expect(left).toBe(900);
    });

    it("no pull-in when the menu fits inside the text field", () => {
        const { left } = computeMenuPosition({ left: 500, top: 300, bottom: 320 }, menu, viewport, "below", 1000, true);
        expect(left).toBe(500); // 500 + 260 = 760 <= 1000
    });

    it("places the menu's left corner at the resolved anchor", () => {
        const { left } = computeMenuPosition({ left: 200, top: 300, bottom: 320 }, menu, viewport, "below", 1200, true);
        expect(left).toBe(200);
    });
});
