import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { FLOW_DEPTH_ENV } from "../src/depth.js";

vi.mock("node:child_process", async (importOriginal) => {
	const original = (await importOriginal()) as typeof import("node:child_process");
	return {
		...original,
		execFile: vi.fn((_cmd, _args, cb) => {
			if (cb) cb(null, "" as any, "" as any);
		}),
	};
});

function createTempProject(config: object = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-notify-test-"));
	const piDir = path.join(dir, ".pi");
	mkdirSync(piDir);
	writeFileSync(path.join(piDir, "notify.json"), JSON.stringify(config));
	return dir;
}

describe("setupNotify depth guard", () => {
	const originalEnv = process.env[FLOW_DEPTH_ENV];

	beforeEach(() => {
		delete process.env[FLOW_DEPTH_ENV];
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env[FLOW_DEPTH_ENV];
		} else {
			process.env[FLOW_DEPTH_ENV] = originalEnv;
		}
	});

	it("registers agent_end listener when depth is 0 (root orchestrator)", async () => {
		process.env[FLOW_DEPTH_ENV] = "0";
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
	});

	it("registers agent_end listener when PI_FLOW_DEPTH is unset", async () => {
		delete process.env[FLOW_DEPTH_ENV];
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
	});

	it("skips registering agent_end listener when depth > 0 (child flow)", async () => {
		process.env[FLOW_DEPTH_ENV] = "1";
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).not.toHaveBeenCalled();
	});

	it("skips registering agent_end listener for deeper nesting (depth=2)", async () => {
		process.env[FLOW_DEPTH_ENV] = "2";
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).not.toHaveBeenCalled();
	});

	it("treats invalid PI_FLOW_DEPTH as 0 (registers listener)", async () => {
		process.env[FLOW_DEPTH_ENV] = "abc";
		const { setupNotify } = await import("../src/notify.js");
		const on = vi.fn();
		const pi = { on } as any;
		setupNotify(pi);
		expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
	});
});

describe("setupNotify deduplication", () => {
	const originalPlatform = process.platform;
	let originalEnv: Record<string, string | undefined>;
	let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
	let tempDir: string;

	beforeEach(() => {
		delete process.env[FLOW_DEPTH_ENV];
		// Save original env vars before clearing them so we can restore in afterEach
		originalEnv = {
			TERM_PROGRAM: process.env.TERM_PROGRAM,
			KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
		};
		delete process.env.TERM_PROGRAM;
		delete process.env.KITTY_WINDOW_ID;
		// Force macOS so desktop backend is predictable (osascript)
		Object.defineProperty(process, "platform", { value: "darwin" });
		stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.mocked(childProcess.execFile).mockClear();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalEnv.TERM_PROGRAM === undefined) {
			delete process.env.TERM_PROGRAM;
		} else {
			process.env.TERM_PROGRAM = originalEnv.TERM_PROGRAM;
		}
		if (originalEnv.KITTY_WINDOW_ID === undefined) {
			delete process.env.KITTY_WINDOW_ID;
		} else {
			process.env.KITTY_WINDOW_ID = originalEnv.KITTY_WINDOW_ID;
		}
		stdoutWriteSpy.mockRestore();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "" as any;
		}
	});

	async function triggerAgentEnd(cwd: string, envVars: Record<string, string> = {}) {
		for (const [k, v] of Object.entries(envVars)) {
			process.env[k] = v;
		}
		const { setupNotify } = await import("../src/notify.js");
		const listeners: Record<string, Function[]> = {};
		const on = vi.fn((event: string, handler: Function) => {
			(listeners[event] ||= []).push(handler);
		});
		const pi = { on } as any;
		setupNotify(pi);
		const handler = listeners["agent_end"]?.[0];
		if (!handler) throw new Error("agent_end not registered");
		await handler(null, { cwd, hasUI: true });
	}

	it("skips desktop notification in Warp to avoid double notification", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, { TERM_PROGRAM: "WarpTerminal" });
		expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("\x1b]777;notify;"));
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});

	it("skips desktop notification in kitty to avoid double notification", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, { KITTY_WINDOW_ID: "1" });
		expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("\x1b]99;i=1:d=0;"));
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});

	it("skips desktop notification in iTerm2 to avoid double notification", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, { TERM_PROGRAM: "iTerm.app" });
		expect(stdoutWriteSpy).toHaveBeenCalled();
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});

	it("sends desktop notification when terminal is not known to support OSC", async () => {
		tempDir = createTempProject();
		await triggerAgentEnd(tempDir, {});
		expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("\x1b]777;notify;"));
		expect(childProcess.execFile).toHaveBeenCalledWith(
			"osascript",
			expect.any(Array),
			expect.any(Function),
		);
	});

	it("sends desktop notification when terminal channel is disabled", async () => {
		tempDir = createTempProject({ channels: { terminal: false, desktop: true, bell: false, sound: false } });
		await triggerAgentEnd(tempDir, { TERM_PROGRAM: "WarpTerminal" });
		expect(stdoutWriteSpy).not.toHaveBeenCalledWith(expect.stringContaining("\x1b]777;notify;"));
		expect(childProcess.execFile).toHaveBeenCalledWith(
			"osascript",
			expect.any(Array),
			expect.any(Function),
		);
	});

	it("sends desktop notification when desktop backend is explicitly configured", async () => {
		tempDir = createTempProject({ desktop: { backend: "macos" } });
		await triggerAgentEnd(tempDir, { TERM_PROGRAM: "WarpTerminal" });
		expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("\x1b]777;notify;"));
		expect(childProcess.execFile).toHaveBeenCalledWith(
			"osascript",
			expect.any(Array),
			expect.any(Function),
		);
	});
});