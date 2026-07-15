/**
 * Audit v17: project isolation + single-source runtime config for Mnemopi.
 *
 * Covers:
 * - loadMnemopiConfig / scoped bank lists never open the shared bank under
 *   default per-project isolation
 * - legacy memories/mnemosyne enhanced|polyphonic shapes normalize without
 *   enabling global banks
 * - live autoRecall/autoRetain hot-patch through applyRuntimePolicy so
 *   selector/settings changes affect the same backend instance tools use
 * - cross-project forget cannot reach another project's bank
 *
 * Each case uses isolated Settings + temp DB roots so process-global defaults
 * cannot leak between tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	listMnemopiScopedBanks,
	loadMnemopiConfig,
	loadMnemopiRuntimePolicy,
	type MnemopiBackendConfig,
	normalizeMnemopiScoping,
} from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	getMnemopiScopedBanks,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const SESSION_ID = "scope-config-session";

let agentRoot: TempDir | undefined;
let state: MnemopiSessionState | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	resetMemoryForTests();
	agentRoot = await TempDir.create("@mnemopi-scope-config-");
	state = undefined;
});

afterEach(async () => {
	await state?.dispose({ consolidate: false });
	state = undefined;
	resetMemoryForTests();
	await agentRoot?.remove().catch(() => {});
	agentRoot = undefined;
	resetSettingsForTest();
});

function makeSession(settings: Settings, mnemopi: MnemopiSessionState | undefined, cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => SESSION_ID,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => mnemopi,
	} as unknown as ToolSession;
}

function installState(config: MnemopiBackendConfig, cwd: string): MnemopiSessionState {
	state = new MnemopiSessionState({
		sessionId: SESSION_ID,
		config,
		session: {
			sessionId: SESSION_ID,
			settings: Settings.isolated({ "memory.backend": "mnemopi" }),
			sessionManager: {
				getEntries: () => [],
				getCwd: () => cwd,
			} as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			refreshBaseSystemPrompt: async () => {},
		} as never,
	});
	setMnemopiSessionState(state.session as never, state);
	return state;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	return block && typeof block.text === "string" ? block.text : "";
}

describe("normalizeMnemopiScoping + listMnemopiScopedBanks", () => {
	it("defaults unknown/legacy scoping to project isolation", () => {
		expect(normalizeMnemopiScoping(undefined)).toBe("per-project");
		expect(normalizeMnemopiScoping("")).toBe("per-project");
		expect(normalizeMnemopiScoping("shared")).toBe("per-project");
		expect(normalizeMnemopiScoping("global")).toBe("global");
		expect(normalizeMnemopiScoping("per-project-tagged")).toBe("per-project-tagged");
	});

	it("never lists the shared bank for plain per-project", () => {
		const banks = listMnemopiScopedBanks({
			scoping: "per-project",
			retainBank: "project-a-hash",
			globalBank: "default",
			recallBanks: ["project-a-hash"],
		});
		expect(banks).toEqual(["project-a-hash"]);
		expect(banks).not.toContain("default");
	});

	it("includes the shared bank only for explicit per-project-tagged", () => {
		const banks = listMnemopiScopedBanks({
			scoping: "per-project-tagged",
			retainBank: "project-a-hash",
			globalBank: "default",
			recallBanks: ["project-a-hash", "default"],
		});
		expect(banks).toEqual(expect.arrayContaining(["project-a-hash", "default"]));
	});
});

describe("loadMnemopiConfig project isolation", () => {
	it("derives distinct project banks and omits the shared bank under per-project", async () => {
		const root = agentRoot!.path();
		const projectA = path.join(root, "projects", "alpha");
		const projectB = path.join(root, "projects", "beta");
		await fs.mkdir(projectA, { recursive: true });
		await fs.mkdir(projectB, { recursive: true });

		const base = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "per-project",
			"mnemopi.dbPath": path.join(root, "mnemopi", "mnemopi.db"),
		});
		const cfgA = loadMnemopiConfig(await base.cloneForCwd(projectA), root);
		const cfgB = loadMnemopiConfig(await base.cloneForCwd(projectB), root);

		expect(cfgA.scoping).toBe("per-project");
		expect(cfgB.scoping).toBe("per-project");
		expect(cfgA.bank).not.toBe(cfgB.bank);
		expect(cfgA.retainBank).toBe(cfgA.bank);
		expect(cfgB.retainBank).toBe(cfgB.bank);
		expect(getMnemopiScopedBanks(cfgA)).toEqual([cfgA.bank]);
		expect(getMnemopiScopedBanks(cfgB)).toEqual([cfgB.bank]);
		expect(getMnemopiScopedBanks(cfgA)).not.toContain(cfgA.globalBank);
		expect(getMnemopiScopedBanks(cfgB)).not.toContain("default");
	});

	it("preserves explicit global and tagged shared intent", async () => {
		const root = agentRoot!.path();
		const project = path.join(root, "projects", "shared-intent");
		await fs.mkdir(project, { recursive: true });
		const globalSettings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "global",
			"mnemopi.dbPath": path.join(root, "mnemopi", "mnemopi.db"),
		});
		const globalCfg = loadMnemopiConfig(await globalSettings.cloneForCwd(project), root);
		expect(globalCfg.scoping).toBe("global");
		expect(globalCfg.retainBank).toBe("default");
		expect(getMnemopiScopedBanks(globalCfg)).toEqual(["default"]);

		const taggedSettings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "per-project-tagged",
			"mnemopi.dbPath": path.join(root, "mnemopi", "mnemopi.db"),
		});
		const taggedCfg = loadMnemopiConfig(await taggedSettings.cloneForCwd(project), root);
		expect(taggedCfg.scoping).toBe("per-project-tagged");
		expect(getMnemopiScopedBanks(taggedCfg)).toEqual(
			expect.arrayContaining([taggedCfg.retainBank!, taggedCfg.globalBank!]),
		);
	});
});

describe("legacy memories/mnemosyne shape normalization", () => {
	it("maps memories.enabled + enhanced/polyphonic into explicit mnemopi fields without global scoping", async () => {
		const root = agentRoot!.path();
		const project = path.join(root, "legacy-project");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(project, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				memories: {
					enabled: true,
					enhanced: true,
					polyphonic: true,
				},
				mnemosyne: {
					enhanced: true,
					// Invalid scoping must not open shared banks.
					scoping: "weird-legacy-value",
				},
			}),
		);

		const settings = await Settings.loadIsolated({
			agentDir,
			cwd: project,
		});
		// memories.enabled → local backend; mnemopi block still normalized.
		expect(settings.get("memory.backend")).toBe("local");
		// Force mnemopi backend to exercise mnemopi field normalization.
		settings.set("memory.backend", "mnemopi");
		expect(settings.get("mnemopi.enhancedRecall")).toBe(true);
		expect(settings.get("mnemopi.polyphonicRecall")).toBe(true);
		// Invalid legacy scoping was dropped; schema default is project isolation.
		expect(settings.get("mnemopi.scoping")).toBe("per-project");

		const cfg = loadMnemopiConfig(settings, agentDir);
		expect(cfg.scoping).toBe("per-project");
		expect(cfg.enhancedRecall).toBe(true);
		expect(cfg.polyphonicRecall).toBe(true);
		expect(getMnemopiScopedBanks(cfg)).not.toContain("default");
	});
});

describe("runtime policy hot-patch (autoRecall/autoRetain)", () => {
	it("applyRuntimePolicy updates the live config tools and auto-recall read", async () => {
		const root = agentRoot!.path();
		const project = path.join(root, "runtime-project");
		await fs.mkdir(project, { recursive: true });
		// Start from empty isolated settings and `set` values onto the global
		// layer — `Settings.isolated({...})` stores seed keys as overrides,
		// which would shadow later `set()` calls and hide runtime policy
		// updates (the same path selector/settings use).
		const settings = Settings.isolated({});
		settings.set("memory.backend", "mnemopi");
		settings.set("mnemopi.scoping", "per-project");
		settings.set("mnemopi.autoRecall", true);
		settings.set("mnemopi.autoRetain", true);
		settings.set("mnemopi.dbPath", path.join(root, "mnemopi", "mnemopi.db"));
		const cfg = loadMnemopiConfig(await settings.cloneForCwd(project), root);
		const live = installState(cfg, project);
		expect(live.config.autoRecall).toBe(true);
		expect(live.config.autoRetain).toBe(true);

		settings.set("mnemopi.autoRecall", false);
		settings.set("mnemopi.autoRetain", false);
		settings.set("mnemopi.polyphonicRecall", true);
		live.applyRuntimePolicy(loadMnemopiRuntimePolicy(settings));

		expect(live.config.autoRecall).toBe(false);
		expect(live.config.autoRetain).toBe(false);
		expect(live.config.polyphonicRecall).toBe(true);
		// Bank routing is unchanged by policy hot-patch.
		expect(live.config.retainBank).toBe(cfg.retainBank);
		expect(getMnemopiScopedBanks(live.config)).toEqual([cfg.bank]);
	});
});

describe("per-project-tagged shared bank is recall-only for memory_edit", () => {
	it("refuses update/forget/invalidate against a shared-bank memory id", async () => {
		const root = agentRoot!.path();
		const project = path.join(root, "tagged-project");
		await fs.mkdir(project, { recursive: true });
		const dbPath = path.join(root, "mnemopi", "mnemopi.db");

		// Seed the shared bank via a global-scoped session.
		const globalSettings = Settings.isolated({});
		globalSettings.set("memory.backend", "mnemopi");
		globalSettings.set("mnemopi.scoping", "global");
		globalSettings.set("mnemopi.dbPath", dbPath);
		const globalCfg = loadMnemopiConfig(await globalSettings.cloneForCwd(project), root);
		const globalState = installState(globalCfg, project);
		const sharedId = globalState.rememberInScope("shared preference lives in default bank", {
			scope: "bank",
			extract: false,
			source: "test-shared",
		});
		expect(sharedId).toBeString();
		await globalState.dispose({ consolidate: false });
		state = undefined;
		resetMemoryForTests();

		// Project-tagged session can recall shared memory but must not mutate it.
		const taggedSettings = Settings.isolated({});
		taggedSettings.set("memory.backend", "mnemopi");
		taggedSettings.set("mnemopi.scoping", "per-project-tagged");
		taggedSettings.set("mnemopi.dbPath", dbPath);
		const taggedCfg = loadMnemopiConfig(await taggedSettings.cloneForCwd(project), root);
		const tagged = installState(taggedCfg, project);
		const session = makeSession(taggedSettings, tagged, project);

		const recalled = await MemoryRecallTool.createIf(session)!.execute("recall-shared", {
			query: "shared preference",
		});
		expect(textOf(recalled)).toContain("shared preference");

		const forget = await MemoryEditTool.createIf(session)!.execute("forget-shared", {
			op: "forget",
			id: sharedId!,
		});
		expect(textOf(forget).toLowerCase()).toContain("read-only");
		expect(forget.details).toMatchObject({ status: "not_editable", bank: "default" });

		const update = await MemoryEditTool.createIf(session)!.execute("update-shared", {
			op: "update",
			id: sharedId!,
			content: "should not overwrite shared bank",
		});
		expect(textOf(update).toLowerCase()).toContain("read-only");

		// Shared memory still present via recall.
		const stillThere = await tagged.recallResultsScoped("shared preference");
		expect(stillThere.some(row => row.content.includes("shared preference"))).toBe(true);
	});
});

describe("concurrent sessions keep independent recall feature policy", () => {
	it("hot-patches one session without flipping another session's beam flags", async () => {
		const root = agentRoot!.path();
		const projectA = path.join(root, "feat-a");
		const projectB = path.join(root, "feat-b");
		await fs.mkdir(projectA, { recursive: true });
		await fs.mkdir(projectB, { recursive: true });

		const settingsA = Settings.isolated({});
		settingsA.set("memory.backend", "mnemopi");
		settingsA.set("mnemopi.scoping", "per-project");
		settingsA.set("mnemopi.polyphonicRecall", true);
		settingsA.set("mnemopi.enhancedRecall", true);
		settingsA.set("mnemopi.dbPath", path.join(root, "mnemopi-a", "mnemopi.db"));
		const cfgA = loadMnemopiConfig(await settingsA.cloneForCwd(projectA), root);

		const settingsB = Settings.isolated({});
		settingsB.set("memory.backend", "mnemopi");
		settingsB.set("mnemopi.scoping", "per-project");
		settingsB.set("mnemopi.polyphonicRecall", false);
		settingsB.set("mnemopi.enhancedRecall", false);
		settingsB.set("mnemopi.dbPath", path.join(root, "mnemopi-b", "mnemopi.db"));
		const cfgB = loadMnemopiConfig(await settingsB.cloneForCwd(projectB), root);

		const liveA = new MnemopiSessionState({
			sessionId: "feat-a",
			config: cfgA,
			session: {
				sessionId: "feat-a",
				sessionManager: { getEntries: () => [], getCwd: () => projectA } as never,
				emitNotice: () => {},
				refreshBaseSystemPrompt: async () => {},
			} as never,
		});
		const liveB = new MnemopiSessionState({
			sessionId: "feat-b",
			config: cfgB,
			session: {
				sessionId: "feat-b",
				sessionManager: { getEntries: () => [], getCwd: () => projectB } as never,
				emitNotice: () => {},
				refreshBaseSystemPrompt: async () => {},
			} as never,
		});
		try {
			expect(liveA.memory.beam.config.polyphonicRecall).toBe(true);
			expect(liveA.memory.beam.config.enhancedRecall).toBe(true);
			expect(liveB.memory.beam.config.polyphonicRecall).toBe(false);
			expect(liveB.memory.beam.config.enhancedRecall).toBe(false);

			// Hot-patch A off — B must stay off and not inherit A's previous on.
			liveA.applyRuntimePolicy({ polyphonicRecall: false, enhancedRecall: false });
			expect(liveA.memory.beam.config.polyphonicRecall).toBe(false);
			expect(liveA.memory.beam.config.enhancedRecall).toBe(false);
			expect(liveB.memory.beam.config.polyphonicRecall).toBe(false);
			expect(liveB.memory.beam.config.enhancedRecall).toBe(false);

			// Hot-patch B on — A must remain off.
			liveB.applyRuntimePolicy({ polyphonicRecall: true, enhancedRecall: true });
			expect(liveB.memory.beam.config.polyphonicRecall).toBe(true);
			expect(liveB.memory.beam.config.enhancedRecall).toBe(true);
			expect(liveA.memory.beam.config.polyphonicRecall).toBe(false);
			expect(liveA.memory.beam.config.enhancedRecall).toBe(false);
		} finally {
			await liveA.dispose({ consolidate: false });
			await liveB.dispose({ consolidate: false });
		}
	});
});

describe("cross-project retain/recall/forget isolation", () => {
	it("project A memories are invisible to project B and forget stays local", async () => {
		const root = agentRoot!.path();
		const projectA = path.join(root, "a", "repo");
		const projectB = path.join(root, "b", "repo");
		await fs.mkdir(projectA, { recursive: true });
		await fs.mkdir(projectB, { recursive: true });
		const dbPath = path.join(root, "mnemopi", "mnemopi.db");

		const settingsA = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "per-project",
			"mnemopi.dbPath": dbPath,
		});
		const cfgA = loadMnemopiConfig(await settingsA.cloneForCwd(projectA), root);
		const liveA = installState(cfgA, projectA);
		const sessionA = makeSession(settingsA, liveA, projectA);

		await MemoryRetainTool.createIf(sessionA)!.execute("retain-a", {
			items: [{ content: "project A secret preference is tabs" }],
		});
		const id = (await liveA.recallResultsScoped("tabs preference"))[0]?.id;
		expect(id).toBeString();

		const recallA = await MemoryRecallTool.createIf(sessionA)!.execute("recall-a", {
			query: "tabs preference",
		});
		expect(textOf(recallA)).toContain("tabs");

		await liveA.dispose({ consolidate: false });
		state = undefined;
		resetMemoryForTests();

		const settingsB = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "per-project",
			"mnemopi.dbPath": dbPath,
		});
		const cfgB = loadMnemopiConfig(await settingsB.cloneForCwd(projectB), root);
		expect(cfgB.bank).not.toBe(cfgA.bank);
		const liveB = installState(cfgB, projectB);
		const sessionB = makeSession(settingsB, liveB, projectB);

		const recallB = await MemoryRecallTool.createIf(sessionB)!.execute("recall-b", {
			query: "tabs preference",
		});
		expect(textOf(recallB)).toBe("No relevant memories found.");

		// Forget from project B with project A's id must not delete across banks.
		const forgetB = await MemoryEditTool.createIf(sessionB)!.execute("forget-b", {
			op: "forget",
			id: id!,
		});
		expect(textOf(forgetB)).toContain("not found");

		await liveB.dispose({ consolidate: false });
		state = undefined;
		resetMemoryForTests();

		// Project A still has its memory.
		const liveA2 = installState(cfgA, projectA);
		const sessionA2 = makeSession(settingsA, liveA2, projectA);
		const recallA2 = await MemoryRecallTool.createIf(sessionA2)!.execute("recall-a2", {
			query: "tabs preference",
		});
		expect(textOf(recallA2)).toContain("tabs");

		const forgetA = await MemoryEditTool.createIf(sessionA2)!.execute("forget-a", {
			op: "forget",
			id: id!,
		});
		expect(textOf(forgetA)).toContain("deleted");
	});
});
