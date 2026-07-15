import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render/ToolView";

const runningJob = {
	id: "job_a",
	type: "task",
	status: "running",
	label: "scout files",
	durationMs: 1200,
	resultText: "",
	errorText: "",
} as const;

describe("ToolView xd:// dispatches", () => {
	it("renders successful execute-mode xdev writes as the inner generate_image tool", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [],
					details: {
						xdev: {
							tool: "generate_image",
							mode: "execute",
							args: { subject: "alpine lake" },
							inner: {
								images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://generate_image");
		expect(html).toContain("alpine lake");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});

	it("renders xd://resolve apply cards from unwrapped details.action, not write args", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				args={{ path: "xd://resolve", content: "looks correct" }}
				result={{
					content: [{ type: "text", text: "Applied" }],
					details: {
						xdev: {
							tool: "resolve",
							mode: "execute",
							args: { reason: "looks correct" },
							inner: {
								action: "apply",
								reason: "looks correct",
								sourceToolName: "ast_edit",
								label: "AST Edit: 1 replacement in 1 file",
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://resolve");
		expect(html).toContain("tv-badge--ok");
		expect(html).toContain("apply");
		expect(html).toContain("proposed → resolved");
		expect(html).toContain("looks correct");
		expect(html).toContain("ast_edit");
		expect(html).toContain("AST Edit: 1 replacement in 1 file");
		expect(html).not.toContain("tv-badge--warn");
	});

	it("renders xd://reject discard cards with reject device semantics", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				args={{ path: "xd://reject", content: "wrong approach" }}
				result={{
					content: [{ type: "text", text: "Discarded" }],
					details: {
						xdev: {
							tool: "reject",
							mode: "execute",
							args: { reason: "wrong approach" },
							inner: {
								action: "discard",
								reason: "wrong approach",
								sourceToolName: "ast_edit",
								label: "AST Edit: 2 replacements in 1 file",
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://reject");
		expect(html).toContain("tv-badge--warn");
		expect(html).toContain("discard");
		expect(html).toContain("proposed → rejected");
		expect(html).toContain("wrong approach");
		expect(html).not.toContain("proposed → resolved");
	});

	it("renders xd://propose plan approval without apply/reject badges", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				args={{ path: "xd://propose", content: "auth-token-refresh" }}
				result={{
					content: [{ type: "text", text: "Plan submitted for approval." }],
					details: {
						xdev: {
							tool: "propose",
							mode: "execute",
							args: { title: "auth-token-refresh" },
							inner: {
								planFilePath: "local://auth-token-refresh-plan.md",
								title: "auth-token-refresh",
								planExists: true,
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://propose");
		expect(html).toContain("tv-badge--accent");
		expect(html).toContain("propose");
		expect(html).toContain("auth-token-refresh");
		expect(html).toContain("local://auth-token-refresh-plan.md");
		expect(html).toContain("plan ready");
		expect(html).not.toContain("proposed → resolved");
		expect(html).not.toContain("proposed → rejected");
		expect(html).not.toContain(">apply<");
		expect(html).not.toContain(">discard<");
	});

	it("prefers unwrapped details over conflicting args for resolve extra and propose title", () => {
		const resolveHtml = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				args={{ path: "xd://resolve", content: "stale reason" }}
				result={{
					content: [{ type: "text", text: "Applied" }],
					details: {
						xdev: {
							tool: "resolve",
							mode: "execute",
							// Conflicting call-side extra must lose to unwrapped details.extra.
							args: { reason: "stale reason", extra: { title: "args-title", note: "from-args" } },
							inner: {
								action: "apply",
								reason: "details reason",
								sourceToolName: "ast_edit",
								label: "AST Edit: conflict case",
								extra: { title: "details-title", note: "from-details" },
							},
						},
					},
				}}
			/>,
		);
		expect(resolveHtml).toContain("details reason");
		expect(resolveHtml).toContain("details-title");
		expect(resolveHtml).toContain("from-details");
		expect(resolveHtml).not.toContain("stale reason");
		expect(resolveHtml).not.toContain("args-title");
		expect(resolveHtml).not.toContain("from-args");

		const proposeHtml = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				args={{ path: "xd://propose", content: "args-slug" }}
				result={{
					content: [{ type: "text", text: "Plan submitted for approval." }],
					details: {
						xdev: {
							tool: "propose",
							mode: "execute",
							args: { title: "args-slug" },
							inner: {
								planFilePath: "local://details-plan.md",
								title: "details-slug",
								planExists: true,
							},
						},
					},
				}}
			/>,
		);
		expect(proposeHtml).toContain("details-slug");
		expect(proposeHtml).toContain("local://details-plan.md");
		expect(proposeHtml).not.toContain("args-slug");
	});
});

describe("tool renderer historical aliases", () => {
	it("renders historical irc transcript names through messaging cards", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="irc"
				defaultOpen
				args={{ op: "send", to: "Worker", message: "ping", await: true }}
				result={{
					content: [{ type: "text", text: "delivered" }],
					details: {
						receipts: [{ to: "Worker", outcome: "woken" }],
					},
				}}
			/>,
		);
		expect(html).toContain("irc");
		expect(html).toContain("to Worker");
		expect(html).toContain("await reply");
		expect(html).toContain("woken");
		expect(html).not.toContain('"op":');
	});

	it("renders historical job transcript names through job cards", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="job"
				defaultOpen
				args={{ list: true }}
				result={{
					content: [{ type: "text", text: "1 job" }],
					details: { jobs: [runningJob] },
				}}
			/>,
		);
		expect(html).toContain("job");
		expect(html).toContain(">list<");
		expect(html).toContain("scout files");
		expect(html).toContain("waiting on 1");
		expect(html).not.toContain('"jobs":');
	});

	it("renders historical await/poll/cancel_job transcript names through job cards", () => {
		const awaitHtml = renderToStaticMarkup(
			<ToolView
				name="await"
				defaultOpen
				args={{ poll: ["job_await"] }}
				result={{
					content: [{ type: "text", text: "1 job" }],
					details: {
						jobs: [{ ...runningJob, id: "job_await", label: "awaiting scout" }],
					},
				}}
			/>,
		);
		expect(awaitHtml).toContain("await");
		expect(awaitHtml).toContain("poll job_await");
		expect(awaitHtml).toContain("awaiting scout");
		expect(awaitHtml).toContain("waiting on 1");
		expect(awaitHtml).not.toContain('"jobs":');

		const pollHtml = renderToStaticMarkup(
			<ToolView
				name="poll"
				defaultOpen
				args={{ poll: ["job_a"] }}
				result={{
					content: [{ type: "text", text: "1 job" }],
					details: { jobs: [runningJob] },
				}}
			/>,
		);
		expect(pollHtml).toContain("poll");
		expect(pollHtml).toContain("poll job_a");
		expect(pollHtml).toContain("scout files");
		expect(pollHtml).toContain("waiting on 1");
		expect(pollHtml).not.toContain('"jobs":');

		const cancelHtml = renderToStaticMarkup(
			<ToolView
				name="cancel_job"
				defaultOpen
				args={{ cancel: ["job_c"] }}
				result={{
					content: [{ type: "text", text: "cancelled" }],
					details: {
						cancelled: [{ id: "job_c", status: "cancelled" }],
						jobs: [
							{
								...runningJob,
								id: "job_c",
								status: "cancelled",
								label: "cancelled scout",
							},
						],
					},
				}}
			/>,
		);
		expect(cancelHtml).toContain("cancel_job");
		expect(cancelHtml).toContain("cancel job_c");
		expect(cancelHtml).toContain("cancelled scout");
		expect(cancelHtml).toContain("1 cancelled");
		expect(cancelHtml).not.toContain('"cancelled":');
	});

	it("falls back to generic JSON for unknown tools", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="totally_unknown_tool_xyz"
				defaultOpen
				args={{ foo: "bar", n: 3 }}
				result={{ content: [{ type: "text", text: "ok" }] }}
			/>,
		);
		expect(html).toContain("totally_unknown_tool_xyz");
		expect(html).toContain("args");
		expect(html).toContain("&quot;foo&quot;: &quot;bar&quot;");
		expect(html).toContain("&quot;n&quot;: 3");
		expect(html).not.toContain("proposed → resolved");
		expect(html).not.toContain("waiting on");
		expect(html).not.toContain("await reply");
	});

	it("still renders historical top-level resolve tool args.action", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="resolve"
				defaultOpen
				args={{ action: "apply", reason: "ship it", extra: { title: "plan-v2" } }}
				result={{
					content: [{ type: "text", text: "Resolved" }],
					details: {
						action: "apply",
						reason: "ship it",
						sourceToolName: "custom_tool",
						label: "Preview: plan-v2",
					},
				}}
			/>,
		);
		expect(html).toContain("apply");
		expect(html).toContain("proposed → resolved");
		expect(html).toContain("ship it");
		expect(html).toContain("custom_tool");
		expect(html).toContain("plan-v2");
	});
});
