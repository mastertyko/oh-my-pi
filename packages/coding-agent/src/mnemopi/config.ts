import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MnemopiOptions } from "@oh-my-pi/pi-mnemopi";
import { getMemoriesDir, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export type MnemopiLlmMode = "none" | "smol" | "remote";

export type MnemopiScoping = "global" | "per-project" | "per-project-tagged";

export type MnemopiProviderOptions = Pick<
	MnemopiOptions,
	"noEmbeddings" | "embeddingModel" | "embeddingApiUrl" | "embeddingApiKey" | "llm" | "debug"
>;

export interface MnemopiBackendConfig {
	dbPath: string;
	baseBank?: string;
	bank: string;
	globalBank?: string;
	retainBank?: string;
	recallBanks?: readonly string[];
	/** Banks this session may open for clear/stats/edit routing. */
	scopedBanks?: readonly string[];
	/** Always set by {@link loadMnemopiConfig}; optional on hand-built test configs. */
	scoping?: MnemopiScoping;
	autoRecall: boolean;
	autoRetain: boolean;
	polyphonicRecall: boolean;
	enhancedRecall: boolean;
	proactiveLinking: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	debug: boolean;
	providerOptions: MnemopiProviderOptions;
	llmMode: MnemopiLlmMode;
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
}

/**
 * Load the canonical Mnemopi runtime config for the current settings + cwd.
 *
 * This is the single source of truth for bank targets, auto-recall/retain, and
 * recall feature flags. Session state and tool dispatch MUST re-read through
 * this loader (or apply a hot-patched slice of its fields) after settings
 * changes — never keep a second divergent representation.
 */
export function loadMnemopiConfig(settings: Settings, agentDir: string): MnemopiBackendConfig {
	const configuredDbPath = settings.get("mnemopi.dbPath");
	const cwd = settings.getCwd();
	const scoping = normalizeMnemopiScoping(settings.get("mnemopi.scoping"));
	const dbPath = configuredDbPath ?? path.join(getMemoriesDir(agentDir), "mnemopi", "mnemopi.db");
	const scope = computeMnemopiBankScope(settings.get("mnemopi.bank"), cwd, scoping);
	// Legacy-bank rescue is project-local only. Global mode has no cwd boundary
	// to probe against and must not widen into sibling project banks.
	const recallBanks =
		scoping === "global" ? scope.recallBanks : extendRecallWithLegacyBanks(scope.recallBanks, dbPath, cwd);
	const llmMode = settings.get("mnemopi.llmMode");
	const embeddingOverride = settings.get("mnemopi.embeddingModel");
	const embeddingVariant = settings.get("mnemopi.embeddingVariant");
	// Map the variant explicitly rather than indexing an object with the raw config
	// value (which could resolve an inherited property like `__proto__`); any value
	// other than the multilingual variant falls back to the English default.
	const variantModel =
		embeddingVariant === "multilingual" ? "intfloat/multilingual-e5-large" : "BAAI/bge-base-en-v1.5";
	// Precedence: explicit `mnemopi.embeddingModel` setting > `MNEMOPI_EMBEDDING_MODEL`
	// env (documented model-level override) > variant-derived default. Without the env
	// term a variant default would silently shadow a user's configured env model.
	const embeddingModel = embeddingOverride?.trim() || Bun.env.MNEMOPI_EMBEDDING_MODEL?.trim() || variantModel;
	const scopedBanks = listMnemopiScopedBanks({
		scoping,
		retainBank: scope.retainBank,
		globalBank: scope.globalBank,
		recallBanks,
	});
	return {
		dbPath,
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks,
		scopedBanks,
		scoping,
		autoRecall: settings.get("mnemopi.autoRecall"),
		autoRetain: settings.get("mnemopi.autoRetain"),
		polyphonicRecall: settings.get("mnemopi.polyphonicRecall"),
		enhancedRecall: settings.get("mnemopi.enhancedRecall"),
		proactiveLinking: settings.get("mnemopi.proactiveLinking"),
		retainEveryNTurns: Math.max(1, Math.floor(settings.get("mnemopi.retainEveryNTurns"))),
		recallLimit: Math.max(1, Math.floor(settings.get("mnemopi.recallLimit"))),
		recallContextTurns: Math.max(1, Math.floor(settings.get("mnemopi.recallContextTurns"))),
		recallMaxQueryChars: Math.max(256, Math.floor(settings.get("mnemopi.recallMaxQueryChars"))),
		injectionTokenLimit: Math.max(256, Math.floor(settings.get("mnemopi.injectionTokenLimit"))),
		debug: settings.get("mnemopi.debug"),
		providerOptions: {
			noEmbeddings: settings.get("mnemopi.noEmbeddings"),
			debug: settings.get("mnemopi.debug"),
			embeddingModel,
			embeddingApiUrl: settings.get("mnemopi.embeddingApiUrl"),
			embeddingApiKey: settings.get("mnemopi.embeddingApiKey"),
			llm:
				llmMode === "remote"
					? {
							baseUrl: settings.get("mnemopi.llmBaseUrl"),
							apiKey: settings.get("mnemopi.llmApiKey"),
							model: settings.get("mnemopi.llmModel"),
						}
					: false,
		},
		llmMode,
		llmBaseUrl: settings.get("mnemopi.llmBaseUrl"),
		llmApiKey: settings.get("mnemopi.llmApiKey"),
		llmModel: settings.get("mnemopi.llmModel"),
	};
}

/** Runtime knobs that can hot-patch a live session without reopening banks. */
export type MnemopiRuntimePolicy = Pick<
	MnemopiBackendConfig,
	| "autoRecall"
	| "autoRetain"
	| "polyphonicRecall"
	| "enhancedRecall"
	| "proactiveLinking"
	| "retainEveryNTurns"
	| "recallLimit"
	| "recallContextTurns"
	| "recallMaxQueryChars"
	| "injectionTokenLimit"
	| "debug"
>;

/** Slice of {@link loadMnemopiConfig} that governs live auto-recall/retain behaviour. */
export function loadMnemopiRuntimePolicy(settings: Settings): MnemopiRuntimePolicy {
	return {
		autoRecall: settings.get("mnemopi.autoRecall"),
		autoRetain: settings.get("mnemopi.autoRetain"),
		polyphonicRecall: settings.get("mnemopi.polyphonicRecall"),
		enhancedRecall: settings.get("mnemopi.enhancedRecall"),
		proactiveLinking: settings.get("mnemopi.proactiveLinking"),
		retainEveryNTurns: Math.max(1, Math.floor(settings.get("mnemopi.retainEveryNTurns"))),
		recallLimit: Math.max(1, Math.floor(settings.get("mnemopi.recallLimit"))),
		recallContextTurns: Math.max(1, Math.floor(settings.get("mnemopi.recallContextTurns"))),
		recallMaxQueryChars: Math.max(256, Math.floor(settings.get("mnemopi.recallMaxQueryChars"))),
		injectionTokenLimit: Math.max(256, Math.floor(settings.get("mnemopi.injectionTokenLimit"))),
		debug: settings.get("mnemopi.debug"),
	};
}

/**
 * Banks a session is allowed to open/clear/edit for the given scope.
 *
 * - `global` / `per-project`: only the retain bank (project isolation).
 * - `per-project-tagged`: project retain bank + explicit shared/global bank.
 *
 * Never includes the shared bank for plain `per-project` — that was the
 * audit defect that let project-local clear/forget/stats touch global DBs.
 */
export function listMnemopiScopedBanks(input: {
	scoping: MnemopiScoping;
	retainBank: string;
	globalBank: string;
	recallBanks?: readonly string[];
}): readonly string[] {
	if (input.scoping === "per-project-tagged") {
		return uniqueBankNames([input.retainBank, input.globalBank, ...(input.recallBanks ?? [])]);
	}
	// per-project and global: retain bank only. Recall banks may include
	// legacy single-cwd rescue banks (still project-bounded) under per-project.
	if (input.scoping === "per-project") {
		return uniqueBankNames([input.retainBank, ...(input.recallBanks ?? [input.retainBank])]);
	}
	return uniqueBankNames([input.retainBank]);
}

export function normalizeMnemopiScoping(value: unknown): MnemopiScoping {
	if (value === "global" || value === "per-project" || value === "per-project-tagged") return value;
	// Default is project isolation. Unknown/legacy values never fall open to
	// shared/global banks — users must opt in with an explicit `global` or
	// `per-project-tagged` setting.
	return "per-project";
}

function uniqueBankNames(banks: readonly string[]): readonly string[] {
	return [...new Set(banks.filter(bank => typeof bank === "string" && bank.length > 0))];
}

const DEFAULT_SHARED_BANK = "default";

// Cap legacy-bank scanning at session start so a pathological banks/
// directory cannot dominate startup latency.
const LEGACY_BANK_SCAN_LIMIT = 64;

export interface MnemopiBankScope {
	baseBank: string;
	bank: string;
	globalBank: string;
	retainBank: string;
	recallBanks: readonly string[];
}

/**
 * Resolve write/recall banks for a session.
 *
 * Mnemopi has no tag-filtered recall, so `per-project-tagged` maps to a
 * project-local write bank plus a shared recall-visible bank. The project
 * bank is derived purely from {@link cwd} — see {@link projectBank} for the
 * stability contract.
 */
export function computeMnemopiBankScope(
	configured: string | undefined,
	cwd: string,
	scoping: MnemopiScoping,
): MnemopiBankScope {
	const project = projectBank(configured, cwd);
	const globalBank = sharedBank(configured);
	switch (scoping) {
		case "global":
			return {
				baseBank: globalBank,
				bank: globalBank,
				globalBank,
				retainBank: globalBank,
				recallBanks: [globalBank],
			};
		case "per-project":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: [project],
			};
		case "per-project-tagged":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: project === globalBank ? [project] : [project, globalBank],
			};
	}
}

function sharedBank(configured: string | undefined): string {
	return sanitizeBankName(configured) ?? DEFAULT_SHARED_BANK;
}

/**
 * Derive the per-project bank id from `cwd` alone.
 *
 * Earlier versions resolved the enclosing git root before hashing, which
 * made the bank id unstable: removing or adding a `.git` anywhere above the
 * cwd repointed the same conversation directory to a different bank and
 * fragmented memories (#2412). The git lookup is gone here; the rescue path
 * for already-fragmented installs lives in {@link extendRecallWithLegacyBanks}.
 */
function projectBank(configured: string | undefined, cwd: string): string {
	const projectRoot = path.resolve(cwd || ".");
	const project = projectBankSegment(projectRoot);
	const base = sanitizeBankName(configured);
	return limitBankName(base ? `${base}-${project}` : project);
}

function projectBankSegment(projectRoot: string): string {
	const project = sanitizeBankName(path.basename(projectRoot)) ?? "default";
	return limitBankName(`${project}-${Bun.hash(projectRoot).toString(36)}`);
}

/**
 * Discover sibling banks under `<dbDir>/banks/` whose durable memory rows
 * (`working_memory` and `episodic_memory`) all carry the active `cwd` in
 * `metadata_json.$.cwd`, and add those safe single-cwd banks to the recall set.
 * This rescues memories stranded by a previous, less-stable bank derivation
 * (#2412) without recalling mixed-cwd legacy banks wholesale under per-project
 * isolation.
 *
 * A bank is admitted only when:
 * - at least one of the durable tables has one or more cwd-matching rows, and
 * - neither table has any row whose cwd is missing or differs from the active cwd.
 * Empty banks (no durable rows) are not admitted.
 *
 * Robust by design: a missing banks directory, unreadable bank dir, or
 * corrupt SQLite file is silently skipped. Scanning is capped at
 * {@link LEGACY_BANK_SCAN_LIMIT} to bound startup cost.
 */
export function extendRecallWithLegacyBanks(
	resolved: readonly string[],
	dbPath: string,
	cwd: string,
): readonly string[] {
	const banksDir = path.join(path.dirname(dbPath), "banks");
	const cwdAbs = path.resolve(cwd || ".");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(banksDir, { withFileTypes: true });
	} catch {
		return resolved;
	}
	const have = new Set(resolved);
	const extras: string[] = [];
	let scanned = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || have.has(entry.name)) continue;
		if (scanned >= LEGACY_BANK_SCAN_LIMIT) break;
		scanned++;
		const candidate = path.join(banksDir, entry.name, "mnemopi.db");
		if (bankOnlyHasCwd(candidate, cwdAbs)) extras.push(entry.name);
	}
	return extras.length === 0 ? resolved : [...resolved, ...extras];
}

function bankOnlyHasCwd(dbPath: string, cwd: string): boolean {
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		const working = probeTableCwd(db, "working_memory", cwd);
		const episodic = probeTableCwd(db, "episodic_memory", cwd);
		const matching = working.matching + episodic.matching;
		const unsafe = working.unsafe + episodic.unsafe;
		return matching > 0 && unsafe === 0;
	} catch (error) {
		logger.debug("Mnemopi: legacy bank probe failed", { dbPath, error: String(error) });
		return false;
	} finally {
		try {
			db?.close();
		} catch {
			// nothing to do — read-only handle.
		}
	}
}

function probeTableCwd(
	db: Database,
	table: "working_memory" | "episodic_memory",
	cwd: string,
): { matching: number; unsafe: number } {
	if (!tableExists(db, table)) return { matching: 0, unsafe: 0 };
	const sql =
		table === "working_memory"
			? `
				SELECT
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') = ? THEN 1 ELSE 0 END) AS matching,
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') IS NULL OR json_extract(metadata_json, '$.cwd') <> ? THEN 1 ELSE 0 END) AS unsafe
				FROM working_memory
			`
			: `
				SELECT
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') = ? THEN 1 ELSE 0 END) AS matching,
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') IS NULL OR json_extract(metadata_json, '$.cwd') <> ? THEN 1 ELSE 0 END) AS unsafe
				FROM episodic_memory
			`;
	const row = db.prepare<{ matching: number; unsafe: number }, [string, string]>(sql).get(cwd, cwd);
	return { matching: row?.matching ?? 0, unsafe: row?.unsafe ?? 0 };
}

function tableExists(db: Database, table: "working_memory" | "episodic_memory"): boolean {
	const row = db
		.prepare<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
		.get(table);
	return row !== null && row !== undefined;
}

function sanitizeBankName(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized ? limitBankName(sanitized) : undefined;
}

function limitBankName(name: string): string {
	if (name.length <= 64) return name;
	const hash = Bun.hash(name).toString(36);
	const prefixLength = Math.max(1, 63 - hash.length);
	const prefix = name.slice(0, prefixLength).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

export function truncateApproxTokens(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
