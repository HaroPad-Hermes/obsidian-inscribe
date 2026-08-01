import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    test: {
        environment: "node",
    },
    resolve: {
        alias: {
            // Mirror tsconfig paths: the plugin imports via "src/...".
            src: path.resolve(__dirname, "src"),
            // Tests never touch the real Obsidian runtime; stub the module so
            // DOM-dependent extensions can still be imported for pure-logic tests.
            obsidian: path.resolve(__dirname, "tests/stubs/obsidian.ts"),
        },
    },
});
