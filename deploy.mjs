// Deploy the built plugin to the live community-plugin folder.
// Shell-agnostic (works from PowerShell or bash): node deploy.mjs
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, "..", "inscribe");

for (const f of ["main.js", "manifest.json", "styles.css"]) {
    mkdirSync(dest, { recursive: true });
    copyFileSync(join(here, f), join(dest, f));
    console.log(`  deployed ${f}`);
}
console.log(`\nDeployed to ${dest}`);
console.log("Now restart Obsidian to load the new build.");
