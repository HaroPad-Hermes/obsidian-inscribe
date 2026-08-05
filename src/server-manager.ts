import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export interface ArbiterServerConfig {
    manageServer: boolean;
    baseUrl: string;
    modelFile: string;
    serverDir: string;
}

// Owns the local spacing-arbiter llama-server process: spawned when the
// plugin loads (if not already serving), killed when the plugin unloads.
// Any failure degrades gracefully — the arbiter routing falls back to the
// provider API (mode "auto"), so a missing/broken server is never fatal.
export class ArbiterServerManager {
    private child: ChildProcess | null = null;

    async ensureRunning(cfg: ArbiterServerConfig): Promise<void> {
        if (!cfg.manageServer || this.child) return;
        if (await this.isHealthy(cfg.baseUrl)) return; // externally managed server
        const exe = join(cfg.serverDir, "llama-server.exe");
        const gguf = join(cfg.serverDir, cfg.modelFile);
        if (!existsSync(exe) || !existsSync(gguf)) {
            console.error("Inscribe: arbiter server binaries missing — using API fallback", { exe, gguf });
            return;
        }
        let port = 8099;
        try {
            port = Number(new URL(cfg.baseUrl).port) || 8099;
        } catch { /* keep default */ }
        try {
            this.child = spawn(exe, [
                "-m", gguf,
                "--host", "127.0.0.1",
                "--port", String(port),
                "-ngl", "99",
                "-c", "2048",
                "--reasoning", "off",
            ], { windowsHide: true, stdio: "ignore" });
            this.child.on("exit", () => { this.child = null; });
        } catch (error) {
            console.error("Inscribe: failed to spawn arbiter server", error);
            this.child = null;
        }
    }

    stop(): void {
        if (this.child) {
            try { this.child.kill(); } catch { /* already dead */ }
            this.child = null;
        }
    }

    private async isHealthy(baseUrl: string): Promise<boolean> {
        try {
            const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
            return res.ok;
        } catch {
            return false;
        }
    }
}
