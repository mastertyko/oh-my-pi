/**
 * Contract tests for mid-session memory backend lifecycle.
 *
 * Exercises real AgentSession tool registry/active-set transitions, dispose races,
 * local-startup cancellation, mnemopi clear/enqueue rehydrate, and the
 * memories.enabled runtime gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { startMemoryStartupTask } from "@oh-my-pi/pi-coding-agent/memories";
import * as memoryStorage from "@oh-my-pi/pi-coding-agent/memories/storage";
import {
	disposeLiveMemorySessionState,
	isMemoryBackendToolName,
	MEMORY_BACKEND_TOOL_NAMES,
	resolveMemoryBackend,
} from "@oh-my-pi/pi-coding-agent/memory-backend";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import type { MnemopiBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	getMnemopiSessionState,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const TEST_SESSION_ID = "lifecycle-session";

function makeMnemopiConfig(
	dbPath: string,
	overrides: (Partial<MnemopiBackendConfig> & Record<string, unknown>) | undefined = {},
): MnemopiBackendConfig {
	return {
		dbPath,
		bank: "test-bank",
		autoRecall: true,
		autoRetain: true,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: false,
		retainEveryNTurns: 3,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1024,
		debug: false,
		providerOptions: {
			noEmbeddings: true,
			embeddingModel: undefined,
			embeddingApiUrl: undefined,
			embeddingApiKey: undefined,
			llm: false,
		},
		llmMode: "none",
		llmBaseUrl: undefined,
		llmApiKey: undefined,
		llmModel: undefined,
		...overrides,
	};
}

function makeListenerSession(options: { settings: Settings; sessionId?: string; agentDir?: string }) {
	const listeners = new Set<(event: { type: string }) => void>();
	let localAbort: AbortController | undefined;
	const session = {
		sessionId: options.sessionId ?? TEST_SESSION_ID,
		settings: options.settings,
		isDisposed: false,
		modelRegistry: {
			getAll: () => [],
			find: () => undefined,
			getApiKey: async () => undefined,
			getApiKeyForProvider: async () => undefined,
			resolver: () => async () => undefined,
		},
		sessionManager: {
			getEntries: () => [],
			getCwd: () => options.agentDir ?? "/tmp/project",
			getSessionFile: () => null as string | null,
			getSessionId: () => options.sessionId ?? TEST_SESSION_ID,
		},
		emitNotice: () => {},
		subscribe: (listener: (event: { type: string }) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getHindsightSessionState: () => undefined,
		setHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => getMnemopiSessionState(session as never),
		refreshBaseSystemPrompt: vi.fn(async () => {
			if (session.isDisposed) throw new Error("refreshBaseSystemPrompt after dispose");
		}),
		cancelLocalMemoryStartup: () => {
			localAbort?.abort();
			localAbort = undefined;
		},
		beginLocalMemoryStartup: () => {
			localAbort?.abort();
			localAbort = new AbortController();
			return localAbort.signal;
		},
		endLocalMemoryStartup: (signal: AbortSignal) => {
			if (localAbort?.signal === signal) localAbort = undefined;
		},
		__listeners: listeners,
	};
	return session;
}

interface RealSessionHarness {
	session: AgentSession;
	settings: Settings;
	tempDir: TempDir;
	authStorage: AuthStorage;
}

async function createRealSessionHarness(options?: {
	backend?: "off" | "local" | "hindsight" | "mnemopi";
	autolearn?: boolean;
}): Promise<RealSessionHarness> {
	const tempDir = TempDir.createSync(`@memory-lifecycle-session-${Date.now()}-`);
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5");

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"memory.backend": options?.backend ?? "off",
		"autolearn.enabled": options?.autolearn ?? false,
	});

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["test"],
			tools: [],
			messages: [],
		},
		streamFn: createMockModel({ responses: [{ content: ["ok"] }] }).stream,
	});

	const toolRegistry = new Map<string, AgentTool>();
	const readTool = {
		name: "read",
		label: "Read",
		description: "read",
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	} as unknown as AgentTool;
	toolRegistry.set("read", readTool);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	let session!: AgentSession;
	const toolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		settings,
		modelRegistry,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionId: () => sessionManager.getSessionId?.() ?? null,
		getHindsightSessionState: () => session.getHindsightSessionState(),
		getMnemopiSessionState: () => session.getMnemopiSessionState(),
		getSessionSpawns: () => null,
	} as unknown as ToolSession;

	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		agentDir: tempDir.path(),
		taskDepth: 0,
		toolRegistry,
		builtInToolNames: ["read"],
		createMemoryToolSession: () => toolSession,
		rebuildSystemPrompt: async toolNames => ({
			systemPrompt: [`tools:${[...toolNames].sort().join(",")}`],
		}),
	});
	await session.setActiveToolsByName(["read"]);

	return { session, settings, tempDir, authStorage };
}

describe("memory backend lifecycle helpers", () => {
	let tempDir: TempDir | undefined;

	beforeEach(() => {
		resetSettingsForTest();
		resetMemoryForTests();
		tempDir = TempDir.createSync(`@memory-lifecycle-${Date.now()}-`);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetMemoryForTests();
		await tempDir?.remove().catch(() => {});
		tempDir = undefined;
	});

	it("exports the memory tool name set used for mid-session rebuilds", () => {
		expect(MEMORY_BACKEND_TOOL_NAMES).toEqual(
			expect.arrayContaining(["retain", "recall", "reflect", "memory_edit", "learn"]),
		);
		expect(isMemoryBackendToolName("retain")).toBe(true);
		expect(isMemoryBackendToolName("bash")).toBe(false);
	});

	it("attachSessionListeners is idempotent (exactly one listener)", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const dbPath = tempDir!.join("mnemopi.db");
		const session = makeListenerSession({ settings });
		const state = new MnemopiSessionState({
			sessionId: TEST_SESSION_ID,
			config: makeMnemopiConfig(dbPath),
			session: session as never,
		});
		setMnemopiSessionState(session as never, state);
		state.attachSessionListeners();
		expect(session.__listeners.size).toBe(1);
		state.attachSessionListeners();
		expect(session.__listeners.size).toBe(1);
		await disposeLiveMemorySessionState(session as never, { consolidateMnemopi: false });
		expect(getMnemopiSessionState(session as never)).toBeUndefined();
		expect(session.__listeners.size).toBe(0);
	});

	it("mnemopi clear rehydrates empty active state with exactly one listener", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const dbPath = tempDir!.join("clear.db");
		const config = makeMnemopiConfig(dbPath, {
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const session = makeListenerSession({ settings, agentDir: tempDir!.path() });
		const state = new MnemopiSessionState({
			sessionId: TEST_SESSION_ID,
			config,
			session: session as never,
		});
		setMnemopiSessionState(session as never, state);
		state.attachSessionListeners();
		state.rememberInScope("clear-me-marker", { scope: "bank", extract: false, source: "test" });
		expect(session.__listeners.size).toBe(1);

		await mnemopiBackend.clear(path.dirname(dbPath), tempDir!.path(), session as never);

		const rehydrated = getMnemopiSessionState(session as never);
		expect(rehydrated).toBeDefined();
		expect(rehydrated).not.toBe(state);
		expect(rehydrated?.aliasOf).toBeUndefined();
		expect(session.__listeners.size).toBe(1);

		const remaining = await rehydrated!.recallResultsScoped("clear-me-marker");
		expect(remaining.every(hit => !String(hit.content).includes("clear-me-marker"))).toBe(true);

		const id = rehydrated!.rememberScoped("after-clear", {
			source: "test",
			scope: "bank",
			extract: false,
		});
		expect(id).toBeTruthy();
		await rehydrated!.dispose({ consolidate: false });
	});

	it("public mnemopiBackend.enqueue alone creates state and exactly one listener", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.dbPath": tempDir!.join("enqueue.db"),
			"mnemopi.llmMode": "none",
		});
		const session = makeListenerSession({
			settings,
			agentDir: tempDir!.path(),
		});
		expect(getMnemopiSessionState(session as never)).toBeUndefined();

		await mnemopiBackend.enqueue(tempDir!.path(), tempDir!.path(), session as never);

		const state = getMnemopiSessionState(session as never);
		expect(state).toBeDefined();
		expect(session.__listeners.size).toBe(1);
		state!.attachSessionListeners();
		expect(session.__listeners.size).toBe(1);
		await state!.dispose({ consolidate: false });
	});

	it("local startup ignores legacy memories.enabled under an explicit non-local backend", () => {
		const openSpy = vi.spyOn(memoryStorage, "openMemoryDb");
		const sessionFile = tempDir!.join("session.jsonl");

		const hindsightWithLegacy = Settings.isolated({
			"memory.backend": "hindsight",
			"memories.enabled": true,
		});
		const session = makeListenerSession({ settings: hindsightWithLegacy });
		session.sessionManager.getSessionFile = () => sessionFile;

		startMemoryStartupTask({
			session: session as never,
			settings: hindsightWithLegacy,
			modelRegistry: session.modelRegistry as never,
			agentDir: tempDir!.path(),
			taskDepth: 0,
		});
		expect(openSpy).not.toHaveBeenCalled();

		const local = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		const localSession = makeListenerSession({ settings: local, sessionId: "local-session" });
		localSession.sessionManager.getSessionFile = () => sessionFile;
		startMemoryStartupTask({
			session: localSession as never,
			settings: local,
			modelRegistry: localSession.modelRegistry as never,
			agentDir: tempDir!.path(),
			taskDepth: 0,
		});
		expect(openSpy).toHaveBeenCalled();
		openSpy.mockRestore();
	});

	it("local startup cancelled mid-phase does not refresh prompt after switch to off", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const sessionFile = tempDir!.join("local-session.jsonl");
		await Bun.write(sessionFile, `${JSON.stringify({ type: "session", id: "s1", cwd: tempDir!.path() })}\n`);

		const session = makeListenerSession({ settings, agentDir: tempDir!.path() });
		session.sessionManager.getSessionFile = () => sessionFile;
		const refresh = session.refreshBaseSystemPrompt;

		startMemoryStartupTask({
			session: session as never,
			settings,
			modelRegistry: session.modelRegistry as never,
			agentDir: tempDir!.path(),
			taskDepth: 0,
		});
		// Switch away immediately: cancel local startup + select off.
		settings.override("memory.backend", "off");
		session.cancelLocalMemoryStartup();
		await disposeLiveMemorySessionState(session as never, { consolidateMnemopi: false });

		await Promise.resolve();
		await Promise.resolve();
		// Only runMemoryStartup end refreshes; cancelled pipeline must not.
		expect(refresh).not.toHaveBeenCalled();
	});

	it("resolveMemoryBackend stays independent of memories.enabled", async () => {
		const a = Settings.isolated({ "memory.backend": "mnemopi", "memories.enabled": false });
		const b = Settings.isolated({ "memory.backend": "off", "memories.enabled": true });
		expect((await resolveMemoryBackend(a)).id).toBe("mnemopi");
		expect((await resolveMemoryBackend(b)).id).toBe("off");
	});
});

describe("AgentSession memory backend transitions", () => {
	let harness: RealSessionHarness | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		resetMemoryForTests();
		if (harness) {
			await harness.session.dispose();
			harness.authStorage.close();
			await harness.tempDir.remove().catch(() => {});
			harness = undefined;
		}
		resetSettingsForTest();
	});

	it("off→mnemopi adds retain/recall/reflect/memory_edit; →off removes them; hindsight never gets memory_edit; preserves read", async () => {
		harness = await createRealSessionHarness({ backend: "off" });
		const { session, settings } = harness;

		expect(session.getActiveToolNames()).toContain("read");
		expect(session.getActiveToolNames().some(isMemoryBackendToolName)).toBe(false);

		settings.override("memory.backend", "mnemopi");
		settings.override("mnemopi.dbPath", path.join(harness.tempDir.path(), "mnemopi.db"));
		settings.override("mnemopi.llmMode", "none");
		await session.applyMemoryBackend();

		const afterMnemopi = session.getActiveToolNames();
		expect(afterMnemopi).toContain("read");
		expect(afterMnemopi).toEqual(expect.arrayContaining(["retain", "recall", "reflect", "memory_edit"]));
		expect(getMnemopiSessionState(session)).toBeDefined();

		settings.override("memory.backend", "hindsight");
		await session.applyMemoryBackend();
		const afterHindsight = session.getActiveToolNames();
		expect(afterHindsight).toContain("read");
		expect(afterHindsight).toEqual(expect.arrayContaining(["retain", "recall", "reflect"]));
		expect(afterHindsight).not.toContain("memory_edit");
		expect(getMnemopiSessionState(session)).toBeUndefined();

		settings.override("memory.backend", "off");
		await session.applyMemoryBackend();
		const afterOff = session.getActiveToolNames();
		expect(afterOff).toContain("read");
		expect(afterOff.some(isMemoryBackendToolName)).toBe(false);
	});

	it("rapid apply latest-wins final tools/state", async () => {
		harness = await createRealSessionHarness({ backend: "off" });
		const { session, settings } = harness;
		settings.override("mnemopi.dbPath", path.join(harness.tempDir.path(), "rapid.db"));
		settings.override("mnemopi.llmMode", "none");

		settings.override("memory.backend", "mnemopi");
		const p1 = session.applyMemoryBackend();
		settings.override("memory.backend", "off");
		const p2 = session.applyMemoryBackend();
		settings.override("memory.backend", "mnemopi");
		const p3 = session.applyMemoryBackend();
		await Promise.all([p1, p2, p3]);

		expect(settings.get("memory.backend")).toBe("mnemopi");
		const names = session.getActiveToolNames();
		expect(names).toEqual(expect.arrayContaining(["retain", "recall", "reflect", "memory_edit", "read"]));
		expect(getMnemopiSessionState(session)).toBeDefined();
	});

	it("backend startup failure leaves no live state; tools match selection and cannot bind stale state", async () => {
		harness = await createRealSessionHarness({ backend: "off" });
		const { session, settings } = harness;
		settings.override("memory.backend", "mnemopi");
		settings.override("mnemopi.dbPath", path.join(harness.tempDir.path(), "fail.db"));
		const startSpy = vi.spyOn(mnemopiBackend, "start").mockImplementation(async () => {
			throw new Error("forced start failure");
		});

		await session.applyMemoryBackend();

		expect(getMnemopiSessionState(session)).toBeUndefined();
		const names = session.getActiveToolNames();
		expect(names).toEqual(expect.arrayContaining(["retain", "recall", "reflect", "memory_edit"]));
		const retain = session.getToolByName("retain");
		expect(retain).toBeDefined();
		await expect(retain!.execute("c1", { items: [{ content: "x" }] } as never)).rejects.toThrow(/not initialised/i);
		startSpy.mockRestore();
	});

	it("apply blocked mid-start + dispose leaves no mnemopi state after both settle", async () => {
		harness = await createRealSessionHarness({ backend: "off" });
		const { session, settings } = harness;
		settings.override("memory.backend", "mnemopi");
		settings.override("mnemopi.dbPath", path.join(harness.tempDir.path(), "race.db"));
		settings.override("mnemopi.llmMode", "none");

		let releaseStart!: () => void;
		const startGate = new Promise<void>(resolve => {
			releaseStart = resolve;
		});
		const originalStart = mnemopiBackend.start.bind(mnemopiBackend);
		const startSpy = vi.spyOn(mnemopiBackend, "start").mockImplementation(async opts => {
			await startGate;
			return originalStart(opts);
		});

		const applyPromise = session.applyMemoryBackend();
		const disposePromise = session.dispose();
		await Promise.resolve();
		releaseStart();
		await Promise.all([applyPromise, disposePromise]);

		expect(session.isDisposed).toBe(true);
		expect(getMnemopiSessionState(session)).toBeUndefined();
		startSpy.mockRestore();
	});
});

describe("selector memory.backend side effect", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("calls applyMemoryBackend when memory.backend changes", () => {
		const applyMemoryBackend = vi.fn(async () => {});
		const controller = new SelectorController({
			session: { applyMemoryBackend },
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("memory.backend", "mnemopi");

		expect(applyMemoryBackend).toHaveBeenCalledTimes(1);
	});
});
