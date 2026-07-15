/**
 * `resolve` / `reject` / `propose` — finalize staged preview or plan approval.
 *
 * Current wire path is a `write` to `xd://resolve|reject|propose`. ToolView
 * unwraps that as `args = xdev.args` and `details = xdev.inner`, so action and
 * plan metadata live on the unwrapped details (not on write args). Historical
 * transcripts still carry a top-level `resolve` tool with `args.action`.
 */
import type { ReactNode } from "react";
import { Badge, Badges, Kv, KvGrid, Note, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, str, truncate } from "../util";

type ResolveAction = "apply" | "discard";

interface ResolutionView {
	kind: "resolution";
	action: ResolveAction | null;
	reason: string | null;
	sourceToolName: string | null;
	label: string | null;
	extra: Record<string, unknown> | null;
}

interface ProposeView {
	kind: "propose";
	title: string | null;
	planFilePath: string | null;
	planExists: boolean | null;
}

type View = ResolutionView | ProposeView;

/**
 * Derive the card model from unwrapped xdev details first, then call args /
 * device name. `reject` defaults to discard when details are not yet present.
 */
function viewOf({ name, args, result }: ToolRenderProps): View {
	const details = detailsRecord(result);

	if (name === "propose") {
		return {
			kind: "propose",
			// Unwrapped xdev.inner is canonical once present.
			title: (details ? str(details.title) : null) ?? str(args.title),
			planFilePath: details ? str(details.planFilePath) : null,
			planExists: details && typeof details.planExists === "boolean" ? details.planExists : null,
		};
	}

	const fromDetails = details && (details.action === "apply" || details.action === "discard") ? details.action : null;
	const fromArgs = args.action === "apply" || args.action === "discard" ? args.action : null;
	// Device name is decisive when the unwrap only carried a reason body.
	const fromName: ResolveAction | null = name === "reject" ? "discard" : fromArgs;
	// Unwrapped details.extra wins over call args when both exist.
	const extra = details && isRecord(details.extra) ? details.extra : isRecord(args.extra) ? args.extra : null;
	return {
		kind: "resolution",
		action: fromDetails ?? fromArgs ?? fromName,
		reason: (details ? str(details.reason) : null) ?? str(args.reason),
		sourceToolName: details ? str(details.sourceToolName) : null,
		label: details ? str(details.label) : null,
		extra,
	};
}

function Summary(props: ToolRenderProps): ReactNode {
	const view = viewOf(props);
	if (view.kind === "propose") {
		const tone = props.result?.isError ? "err" : "accent";
		const title = view.title ? truncate(normalizeWs(view.title), 100) : null;
		return (
			<>
				<Badge tone={tone}>propose</Badge> {title && <span>{title}</span>}
			</>
		);
	}
	const tone = props.result?.isError ? "err" : view.action === "apply" ? "ok" : "warn";
	const reason = view.reason ? truncate(normalizeWs(view.reason), 100) : null;
	return (
		<>
			<Badge tone={tone}>{view.action ?? "?"}</Badge> {reason && <span>{reason}</span>}
		</>
	);
}

function Body(props: ToolRenderProps): ReactNode {
	const view = viewOf(props);
	if (view.kind === "propose") {
		const tone = props.result?.isError ? "err" : "accent";
		const title = view.title ? truncate(normalizeWs(view.title), 120) : null;
		const planFilePath = view.planFilePath ? truncate(normalizeWs(view.planFilePath), 160) : null;
		return (
			<>
				<Badges
					items={[
						<Badge key="action" tone={tone}>
							propose
						</Badge>,
						title && <span key="title">{title}</span>,
						view.planExists === true && (
							<Badge key="exists" tone="ok">
								plan ready
							</Badge>
						),
						view.planExists === false && (
							<Badge key="missing" tone="warn">
								plan missing
							</Badge>
						),
					]}
				/>
				{planFilePath && (
					<KvGrid>
						<Kv k="plan">{planFilePath}</Kv>
					</KvGrid>
				)}
				<ResultText result={props.result} maxLines={6} />
			</>
		);
	}

	const tone = props.result?.isError ? "err" : view.action === "apply" ? "ok" : "warn";
	const actionLabel =
		view.action === "apply"
			? "proposed → resolved"
			: view.action === "discard"
				? "proposed → rejected"
				: (view.action ?? "?");
	const extraRows: ReactNode[] = [];
	if (view.extra) {
		for (const k in view.extra) {
			const v = view.extra[k];
			let text: string;
			if (typeof v === "string") text = v;
			else {
				try {
					text = JSON.stringify(v) ?? String(v);
				} catch {
					text = String(v);
				}
			}
			extraRows.push(
				<Kv key={k} k={k}>
					{truncate(normalizeWs(text), 200)}
				</Kv>,
			);
		}
	}
	return (
		<>
			<Badges
				items={[
					<Badge key="action" tone={tone}>
						{actionLabel}
					</Badge>,
					view.sourceToolName && <Badge key="source">{view.sourceToolName}</Badge>,
					view.label && <span key="label">{truncate(normalizeWs(view.label), 120)}</span>,
				]}
			/>
			{view.reason && <Note>{view.reason}</Note>}
			{extraRows.length > 0 && <KvGrid>{extraRows}</KvGrid>}
			<ResultText result={props.result} maxLines={6} />
		</>
	);
}

export const resolveRenderer: ToolRenderer = { Summary, Body };
