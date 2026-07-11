import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, FetchImpl, Model, ProviderSessionState, Usage } from "@oh-my-pi/pi-ai";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AutoLearnController, buildAutoLearnInstructions } from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAutoLearnCaptureRunner } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { type } from "arktype";

class FakeSession {
	readonly listeners: Array<(event: AgentSessionEvent) => void> = [];
	readonly captures: string[] = [];
	planEnabled = false;
	goalEnabled = false;
	captureGate: Promise<void> | undefined;
	captureError: Error | undefined;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	async capture(content: string): Promise<void> {
		this.captures.push(content);
		const gate = this.captureGate;
		const error = this.captureError;
		if (gate) await gate;
		if (error) throw error;
	}

	getPlanModeState(): { enabled: boolean } | undefined {
		return this.planEnabled ? { enabled: true } : undefined;
	}

	getGoalModeState(): { enabled: boolean } | undefined {
		return this.goalEnabled ? { enabled: true } : undefined;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	toolCalls(n: number): void {
		for (let i = 0; i < n; i++) {
			this.emit({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "read", result: null });
		}
	}

	agentStart(): void {
		this.emit({ type: "agent_start" });
	}

	agentEnd(messages: AgentMessage[] = []): void {
		this.emit({ type: "agent_end", messages });
	}
}

function install(session: FakeSession, overrides: Record<string, unknown> = {}): Settings {
	const settings = Settings.isolated({ "autolearn.enabled": true, ...overrides });
	new AutoLearnController({
		session: session as unknown as AgentSession,
		settings,
		capture: content => session.capture(content),
	});
	return settings;
}

async function settleCaptures(): Promise<void> {
	await Bun.sleep(1);
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function googleInteractionsModel(): Model<"google-generative-ai"> {
	return buildModel({
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	});
}

function storedAssistant(responseId: string): AssistantMessage {
	return {
		role: "assistant",
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-3.5-flash",
		content: [{ type: "text", text: "Primary answer" }],
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 2,
		responseId,
		providerPayload: { type: "openaiResponsesHistory", items: [{ id: "primary-native-item" }] },
	};
}

function googleSseResponse(): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text: "Captured." }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("AutoLearnController", () => {
	it("does not inject a passive capture", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(0);
	});

	it("frames auto-capture as terminal automation, never user approval (#3504)", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		const body = session.captures[0] ?? "";
		expect(body).toMatch(/not a user reply|not from the user/i);
		expect(body).toMatch(/not.*(approval|accept|pending|prior)/i);
		expect(body).toMatch(/then stop\./i);
		expect(body).toMatch(/do not.*(continue|resume|other tools)/i);
		expect(body).toMatch(/wait for the user'?s next prompt/i);
	});

	it("does not capture below the threshold", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(4);
		session.agentEnd();
		expect(session.captures).toHaveLength(0);
	});

	it("does not capture during plan mode", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(0);
	});

	it("does not combine tool calls across separate sub-threshold turns", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(3);
		session.agentEnd();
		session.toolCalls(3);
		session.agentEnd();
		expect(session.captures).toHaveLength(0);
	});

	it("discards plan-mode tool counts before the next turn", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		session.planEnabled = false;
		session.toolCalls(1);
		session.agentEnd();
		expect(session.captures).toHaveLength(0);
	});

	it("honors a live disable without leaking prior tool counts", async () => {
		const session = new FakeSession();
		const settings = Settings.isolated({ "autolearn.autoContinue": true });
		settings.set("autolearn.enabled", true);
		new AutoLearnController({
			session: session as unknown as AgentSession,
			settings,
			capture: content => session.capture(content),
		});
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
		settings.set("autolearn.enabled", false);
		session.toolCalls(5);
		session.agentEnd();
		settings.set("autolearn.enabled", true);
		session.toolCalls(1);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
	});

	it("does not compete with goal mode", async () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(0);
		session.goalEnabled = false;
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
	});

	it("skips a turn that started in goal mode even when the goal ends mid-turn", async () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.agentStart();
		session.toolCalls(5);
		session.goalEnabled = false;
		session.agentEnd();
		expect(session.captures).toHaveLength(0);
		session.agentStart();
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
	});

	it("coalesces newer eligible stops behind an in-flight capture", async () => {
		const session = new FakeSession();
		const release = Promise.withResolvers<void>();
		session.captureGate = release.promise;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		session.toolCalls(5);
		session.agentEnd();
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
		session.captureGate = undefined;
		release.resolve();
		await settleCaptures();
		expect(session.captures).toHaveLength(2);
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(3);
	});

	it("does not queue an ineligible stop behind an in-flight capture", async () => {
		const session = new FakeSession();
		const release = Promise.withResolvers<void>();
		session.captureGate = release.promise;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		session.toolCalls(4);
		session.agentEnd();
		session.captureGate = undefined;
		release.resolve();
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
	});

	it("clears the in-flight guard after capture failure", async () => {
		const session = new FakeSession();
		session.captureError = new Error("capture failed");
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		session.captureError = undefined;
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(2);
	});

	it("respects a custom minToolCalls threshold", async () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true, "autolearn.minToolCalls": 2 });
		session.toolCalls(2);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
	});
});

describe("isolated auto-learn capture", () => {
	function captureTool(name: string, description: string): AgentTool {
		return {
			name,
			label: name,
			description,
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "captured" }] }),
		};
	}

	it("uses backend-independent manage_skill and sends full Google context without the primary anchor", async () => {
		const model = googleInteractionsModel();
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const readTool = captureTool("read", "Read files");
		const primaryAssistant = storedAssistant("primary-interaction");
		const sourceProviderState = new Map<string, ProviderSessionState>();
		const sourceAgent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Primary system prompt"],
				tools: [readTool, manageSkillTool],
				messages: [{ role: "user", content: "Earlier task", timestamp: 1 }, primaryAssistant],
			},
			providerSessionState: sourceProviderState,
		});
		const queuedUserMessage: AgentMessage = {
			role: "user",
			content: "Concurrent user correction",
			timestamp: 3,
		};
		sourceAgent.steer(queuedUserMessage);
		let primaryEvents = 0;
		sourceAgent.subscribe(() => primaryEvents++);

		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return googleSseResponse();
		};
		Object.assign(fetchMock, { preconnect: fetch.preconnect });
		let captureMessages: AgentMessage[] = [];
		let captureProviderState: Map<string, ProviderSessionState> | undefined;
		let captureSessionId: string | undefined;
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: [manageSkillTool],
			createSessionId: () => "0193c8f2-7b1a-7c4d-9e2f-123456789abc",
			createAgent: options => {
				captureMessages = options.initialState?.messages ?? [];
				captureProviderState = options.providerSessionState;
				captureSessionId = options.sessionId;
				return new Agent({
					...options,
					convertToLlm,
					streamFn: (requestModel, context, streamOptions) =>
						streamGoogle(requestModel as Model<"google-generative-ai">, context, {
							...streamOptions,
							apiKey: "test-key",
							fetch: fetchMock,
						}),
				});
			},
		});

		await runCapture("Automated capture prompt");

		expect(captureSessionId).toBe("0193c8f2-7b1a-7c4d-9e2f-123456789abc");
		expect(captureProviderState).not.toBe(sourceProviderState);
		expect(captureProviderState?.size).toBe(0);
		const detachedAssistant = captureMessages.find(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(detachedAssistant?.responseId).toBeUndefined();
		expect(detachedAssistant?.providerPayload).toBeUndefined();
		expect(requestBody?.previous_interaction_id).toBeUndefined();
		expect(JSON.stringify(requestBody?.contents)).toContain("Earlier task");
		expect(JSON.stringify(requestBody)).toContain("Automated capture prompt");
		expect(JSON.stringify(requestBody?.tools)).toContain("manage_skill");
		expect(JSON.stringify(requestBody?.tools)).not.toContain("learn");
		expect(JSON.stringify(requestBody?.tools)).not.toContain("read");
		expect(sourceAgent.state.messages).toHaveLength(2);
		expect((sourceAgent.state.messages[1] as AssistantMessage).responseId).toBe("primary-interaction");
		expect(sourceAgent.peekSteeringQueue()).toEqual([queuedUserMessage]);
		expect(primaryEvents).toBe(0);
	});

	it("adds learn alongside manage_skill when a memory backend provides it", async () => {
		const model = googleInteractionsModel();
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const learnTool = captureTool("learn", "Store long-term memory");
		const sourceAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [manageSkillTool, learnTool] },
		});
		const captureMock = createMockModel({ responses: [{ content: ["Captured."] }] });
		let captureToolNames: string[] = [];
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: [manageSkillTool, learnTool],
			createAgent: options => {
				captureToolNames = options.initialState?.tools?.map(tool => tool.name) ?? [];
				return new Agent({
					...options,
					convertToLlm,
					streamFn: captureMock.stream,
				});
			},
		});

		await runCapture("Capture reusable knowledge");

		expect(captureToolNames).toEqual(["manage_skill", "learn"]);
		expect(captureMock.calls).toHaveLength(1);
	});

	it("keeps credential and account metadata on the source affinity while using a fresh transport session", async () => {
		const captureMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["Captured."] }],
		});
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const credentialsBySession = new Map([
			["primary-affinity", "primary-key"],
			["capture-transport", "other-key"],
		]);
		const accountsBySession = new Map([
			["primary-affinity", "account-primary"],
			["capture-transport", "account-other"],
		]);
		const resolvedAffinities: string[] = [];
		let sourceAgent: Agent;
		sourceAgent = new Agent({
			sessionId: "primary-affinity",
			getApiKey: () => async () => {
				const affinity = sourceAgent.sessionId ?? "";
				resolvedAffinities.push(affinity);
				return credentialsBySession.get(affinity);
			},
			initialState: { model: captureMock, systemPrompt: ["Test"], tools: [manageSkillTool] },
		});
		sourceAgent.setMetadataResolver(() => {
			const account = accountsBySession.get(sourceAgent.sessionId ?? "");
			return account ? { user_id: account } : undefined;
		});
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: [manageSkillTool],
			createSessionId: () => "capture-transport",
			createAgent: options =>
				new Agent({
					...options,
					convertToLlm,
					streamFn: captureMock.stream,
				}),
		});

		await runCapture("Capture with source affinity");

		expect(captureMock.calls[0]?.options?.sessionId).toBe("capture-transport");
		expect(resolvedAffinities).toEqual(["primary-affinity"]);
		expect(captureMock.calls[0]?.options?.metadata).toEqual({ user_id: "account-primary" });
	});

	it("aborts a blocked detached capture and closes its provider state", async () => {
		const model = googleInteractionsModel();
		const manageSkillTool = captureTool("manage_skill", "Manage reusable skills");
		const sourceAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [manageSkillTool] },
		});
		const streamStarted = Promise.withResolvers<void>();
		const captureMock = createMockModel({
			responses: [
				() => {
					streamStarted.resolve();
					return { content: ["Blocked capture"], delayMs: 60_000 };
				},
			],
		});
		let providerState: Map<string, ProviderSessionState> | undefined;
		let closeCalls = 0;
		const runCapture = createAutoLearnCaptureRunner({
			sourceAgent,
			captureTools: [manageSkillTool],
			createAgent: options => {
				providerState = options.providerSessionState;
				providerState?.set("blocked", { close: () => closeCalls++ });
				return new Agent({
					...options,
					convertToLlm,
					streamFn: captureMock.stream,
				});
			},
		});
		const controller = new AbortController();

		const capture = runCapture("Capture before disposal", controller.signal);
		await streamStarted.promise;
		controller.abort();
		await capture;

		expect(closeCalls).toBe(1);
		expect(providerState?.size).toBe(0);
	});

	it("does not nudge when the turn ended with stopReason aborted", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		const abortedMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};
		session.agentEnd([abortedMessage]);
		expect(session.captures).toHaveLength(0);
	});
});

describe("buildAutoLearnInstructions", () => {
	it("returns null when manage_skill is not in the active tool set", () => {
		expect(buildAutoLearnInstructions({ manageSkill: false, learn: false })).toBeNull();
		// learn without manage_skill still yields no guidance (manage_skill gates it).
		expect(buildAutoLearnInstructions({ manageSkill: false, learn: true })).toBeNull();
	});

	it("includes the learn addendum when the learn tool is present", () => {
		const text = buildAutoLearnInstructions({ manageSkill: true, learn: true });
		expect(text).toContain("manage_skill");
		expect(text).toContain("long-term memory");
	});

	it("omits the learn addendum when only manage_skill is present", () => {
		const text = buildAutoLearnInstructions({ manageSkill: true, learn: false });
		expect(text).toContain("manage_skill");
		expect(text).not.toContain("long-term memory");
	});
});
