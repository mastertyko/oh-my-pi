import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import { XdevRegistry } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// xdev mounting is default-on: discoverable tools like ast_edit unmount into
// xd://, and a plain `write xd://ast_edit` dispatches them. These guard the
// resolution-device symbols write.ts pulls from ./resolve — a missing import
// threw `ReferenceError: isResolutionDeviceName is not defined` on *every*
// xd:// write, in both the executor (approval + execute) and the streaming
// renderer (surfacing as the error text inside a generic Write frame).
function xdevSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
		...overrides,
	};
}

describe("read and write route xd:// device URLs", () => {
	it("lists, documents, and dispatches an ast_edit device", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				xdevSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
			);
			// xdev on: ast_edit is unmounted into xd://; write stays in the toolset.
			const write = tools.find(entry => entry.name === "write");
			const read = tools.find(entry => entry.name === "read");
			expect(read).toBeDefined();
			expect(write).toBeDefined();
			expect(tools.some(entry => entry.name === "ast_edit")).toBe(false);

			const listing = await read!.execute("read-xd-list", { path: "xd://" });
			expect(listing.content.find(entry => entry.type === "text")?.text).toContain("xd://ast_edit");
			const docs = await read!.execute("read-xd-docs", { path: "xd://ast_edit" });
			expect(docs.content.find(entry => entry.type === "text")?.text).toContain("# ast_edit");

			const content = JSON.stringify({
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});

			// Approval evaluates the mounted tool's function-valued approval against
			// the parsed device args (filesystem paths → write, not a blind exec).
			const approval = write!.approval;
			expect(typeof approval).toBe("function");
			if (typeof approval === "function") {
				expect(approval({ path: "xd://ast_edit", content })).toBe("write");
				// Internal-only targets drop to the mounted tool's read tier.
				expect(
					approval({
						path: "xd://ast_edit",
						content: JSON.stringify({
							ops: [{ pat: "a", out: "b" }],
							paths: ["local://plan.md"],
						}),
					}),
				).toBe("read");
				// Malformed content cannot be evaluated — fail closed to exec.
				expect(approval({ path: "xd://ast_edit", content: "{not-json" })).toBe("exec");
				expect(approval({ path: "xd://ast_edit", content: "[1,2]" })).toBe("exec");
			}

			// Execute dispatches through the xdev registry to the mounted ast_edit,
			// staging a preview (not a direct apply).
			const previewResult = await write!.execute("write-xdev-preview", { path: "xd://ast_edit", content });
			expect(previewResult.isError).toBeUndefined();
			expect(previewResult.details?.xdev?.tool).toBe("ast_edit");
			expect(previewResult.details?.xdev?.mode).toBe("execute");
			const previewText = previewResult.content.find(entry => entry.type === "text")?.text ?? "";
			expect(previewText).toContain("modernWrap");

			// The staged preview applies through the resolve queue and rewrites disk.
			const invoker = queue.peekPendingInvoker();
			expect(invoker).toBeDefined();
			await invoker!({ action: "apply", reason: "apply xdev ast edit" });
			expect(await Bun.file(filePath).text()).toContain("modernWrap(x, value)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("revokes and re-enables built-in devices through reconcile", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-revoke-"));
		try {
			const session = xdevSession(tempDir);
			const tools = await createTools(session);
			const write = tools.find(entry => entry.name === "write");
			const read = tools.find(entry => entry.name === "read");
			const registry = session.xdevRegistry;
			if (!write || !read || !registry) throw new Error("expected write/read/xdev");

			const before = registry.list().map(tool => tool.name);
			expect(before).toContain("ast_edit");
			expect(before).toContain("debug");

			// Restricted active set: drop every built-in device. Listing, docs, and
			// dispatch must all fail closed — no name blacklist, just the active set.
			registry.reconcile([]);
			expect(registry.size).toBe(0);
			expect(registry.list()).toEqual([]);
			const listing = await read.execute("read-xd-empty", { path: "xd://" });
			const listingText = listing.content.find(entry => entry.type === "text")?.text ?? "";
			expect(listingText).toContain("0 mounted tool devices");
			expect(listingText).not.toContain("xd://ast_edit");
			await expect(read.execute("read-xd-docs-missing", { path: "xd://ast_edit" })).rejects.toThrow(
				/No such tool device: xd:\/\/ast_edit/,
			);
			await expect(
				write.execute("write-xd-revoked", {
					path: "xd://ast_edit",
					content: JSON.stringify({ ops: [], paths: [] }),
				}),
			).rejects.toThrow(/No such tool device: xd:\/\/ast_edit/);

			// Re-enable a single built-in: list/docs/dispatch parity restores for it only.
			// Re-seed from a fresh createTools catalog so we have the real tool instance.
			const seedSession = xdevSession(tempDir);
			await createTools(seedSession);
			const seed = seedSession.xdevRegistry;
			if (!seed) throw new Error("expected seed registry");
			const astEdit = seed.get("ast_edit");
			const debug = seed.get("debug");
			if (!astEdit || !debug) throw new Error("expected ast_edit and debug");
			// Point the live session registry at the re-enabled device (simulates
			// AgentSession applying a restored active set).
			registry.reconcile([astEdit]);
			expect(registry.list().map(tool => tool.name)).toEqual(["ast_edit"]);
			expect(registry.get("debug")).toBeUndefined();
			const restoredListing = await read.execute("read-xd-restored", { path: "xd://" });
			const restoredText = restoredListing.content.find(entry => entry.type === "text")?.text ?? "";
			expect(restoredText).toContain("xd://ast_edit");
			expect(restoredText).not.toContain("xd://debug");
			const restoredDocs = await read.execute("read-xd-docs-restored", { path: "xd://ast_edit" });
			expect(restoredDocs.content.find(entry => entry.type === "text")?.text).toContain("# ast_edit");
			// debug stays revoked.
			await expect(read.execute("read-xd-debug-revoked", { path: "xd://debug" })).rejects.toThrow(
				/No such tool device: xd:\/\/debug/,
			);

			// Dynamic mounts still work alongside a re-enabled built-in.
			const custom = Object.create(debug) as typeof debug;
			Object.defineProperty(custom, "name", { value: "mcp__custom_probe" });
			Object.defineProperty(custom, "description", { value: "custom probe tool" });
			Object.defineProperty(custom, "loadMode", { value: "discoverable" });
			registry.reconcile([astEdit, custom]);
			expect(registry.list().map(tool => tool.name)).toEqual(["ast_edit", "mcp__custom_probe"]);
			const mixedListing = await read.execute("read-xd-mixed", { path: "xd://" });
			const mixedText = mixedListing.content.find(entry => entry.type === "text")?.text ?? "";
			expect(mixedText).toContain("xd://ast_edit");
			expect(mixedText).toContain("xd://mcp__custom_probe");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("evaluates function-valued mounted approvals for read vs exec tiers", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-approval-"));
		try {
			const tools = await createTools(xdevSession(tempDir));
			const write = tools.find(entry => entry.name === "write");
			expect(write).toBeDefined();
			const approval = write!.approval;
			expect(typeof approval).toBe("function");
			if (typeof approval !== "function") return;

			// debug: readonly action → read; mutating action → exec.
			expect(approval({ path: "xd://debug", content: JSON.stringify({ action: "sessions" }) })).toBe("read");
			expect(approval({ path: "xd://debug", content: JSON.stringify({ action: "launch", program: "x" }) })).toBe(
				"exec",
			);
			// ast_edit: internal-only paths → read; filesystem paths → write.
			expect(
				approval({
					path: "xd://ast_edit",
					content: JSON.stringify({
						ops: [{ pat: "a", out: "b" }],
						paths: ["local://plan.md"],
					}),
				}),
			).toBe("read");
			expect(
				approval({
					path: "xd://ast_edit",
					content: JSON.stringify({
						ops: [{ pat: "a", out: "b" }],
						paths: ["/tmp/file.ts"],
					}),
				}),
			).toBe("write");
			// Unknown device (not mounted / empty name) stays fail-closed at exec.
			expect(approval({ path: "xd://not_a_real_device", content: "{}" })).toBe("exec");
			// Empty content still evaluates the function against {} (ast_edit → write).
			expect(approval({ path: "xd://ast_edit", content: "" })).toBe("write");
			expect(approval({ path: "xd://ast_edit" })).toBe("write");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("renderCall withholds partial xd:// prefixes, then renders settled ordinary paths", async () => {
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const options = { expanded: false, isPartial: true };

		const content = JSON.stringify({
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: ["/tmp/legacy.ts"],
		});

		// Path still streaming (no content field yet): render nothing so the user
		// never sees a half-typed "xd://ast_" frame — including ordinary prefixes
		// that could still become xd:// ("x", "xd", "xd:", "xd:/").
		expect(writeToolRenderer.renderCall({ path: "xd://ast_e" }, options, uiTheme)).toBeUndefined();
		for (const partial of ["x", "xd", "xd:", "xd:/"]) {
			expect(writeToolRenderer.renderCall({ path: partial }, options, uiTheme)).toBeUndefined();
		}

		// Settled ordinary paths that only shared the xd:// prefix render as
		// normal Write frames (not blank, not device-delegated).
		for (const ordinary of ["x", "xd", "xd:", "xd:/"]) {
			const ordinaryRendered = writeToolRenderer.renderCall(
				{ path: ordinary, content: "hello\n" },
				options,
				uiTheme,
			);
			expect(ordinaryRendered).toBeDefined();
			const ordinaryText = ordinaryRendered!.render(80).join("\n");
			expect(ordinaryText).toContain("Write");
			expect(ordinaryText).toContain(ordinary);
		}

		// Path settled + content streaming: delegate to the mounted tool's renderer
		// instead of throwing ReferenceError inside a generic Write frame.
		const rendered = writeToolRenderer.renderCall({ path: "xd://ast_edit", content }, options, uiTheme);
		expect(rendered).toBeDefined();

		// Live partial content still withholds until path settles; rebuilt settled
		// previews keep the ordinary frame.
		const livePartial = writeToolRenderer.renderCall({ path: "xd" }, { ...options, isPartial: true }, uiTheme);
		expect(livePartial).toBeUndefined();
		const rebuilt = writeToolRenderer.renderCall(
			{ path: "xd", content: "line 1\nline 2\n" },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		expect(rebuilt).toBeDefined();
	});

	it("docsAll inlines small device docs and falls back to a listing past the caps", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-docs-"));
		try {
			const session = xdevSession(tempDir);
			await createTools(session);
			const mounted = session.xdevRegistry?.list() ?? [];
			expect(mounted.length).toBeGreaterThan(0);

			// One device with a pathological description must fall back to the
			// listing without starving the rest of the catalog.
			const giant = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(giant, "name", { value: "giant_mcp_tool" });
			Object.defineProperty(giant, "description", { value: "x".repeat(XdevRegistry.DOCS_PER_DEVICE_CAP + 1) });
			const registry = new XdevRegistry([...mounted, giant]);

			const docs = registry.docsAll();
			expect(docs.length).toBeLessThan(XdevRegistry.DOCS_TOTAL_BUDGET + XdevRegistry.DOCS_PER_DEVICE_CAP);
			expect(docs).toContain(`## ${mounted[0]!.name}`);
			expect(docs).toContain("## Additional devices (docs on demand)");
			expect(docs).toContain("- xd://giant_mcp_tool —");
			expect(docs).not.toContain("## giant_mcp_tool");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("docsAll truncates external (dynamic-mount) descriptions to the cap; built-ins and read xd:// stay full", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-external-"));
		try {
			const session = xdevSession(tempDir);
			await createTools(session);
			const registry = session.xdevRegistry;
			if (!registry) throw new Error("expected xdev registry");
			const mounted = registry.list();

			const longDescription = `LEDE ${"y".repeat(XdevRegistry.EXTERNAL_DESCRIPTION_CAP * 3)} TAIL`;
			const external = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(external, "name", { value: "mcp_external_tool" });
			Object.defineProperty(external, "description", { value: longDescription });
			// Keep the built-in mounted so curated full docs remain in the catalog.
			registry.reconcile([mounted[0]!, external]);

			const docs = registry.docsAll();
			// External device: schema section present, description cut at the cap.
			expect(docs).toContain("## mcp_external_tool");
			expect(docs).toContain("LEDE ");
			expect(docs).not.toContain("TAIL");
			expect(docs).toContain("… (full docs: read xd://mcp_external_tool)");
			// Built-in devices keep their full curated description.
			expect(docs).toContain(mounted[0]!.description ?? "");
			// On-demand docs return the untruncated text.
			expect(registry.docs("mcp_external_tool")).toContain("TAIL");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
