import { afterEach, describe, expect, it } from "bun:test";
import { AutoLearnController, buildAutoLearnInstructions } from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

interface CapturedNudge {
	message: { customType: string; content: string; display?: boolean; attribution?: string };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

class FakeSession {
	readonly listeners: Array<(event: AgentSessionEvent) => void> = [];
	readonly sent: CapturedNudge[] = [];
	planEnabled = false;
	goalEnabled = false;
	/** Whether a triggerTurn dispatch actually starts a synthetic turn. */
	turnStarts = true;
	/** Force the dispatch to reject (models a failed send). */
	failSend = false;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	async sendCustomMessage(message: CapturedNudge["message"], options?: CapturedNudge["options"]): Promise<boolean> {
		if (this.failSend) throw new Error("send failed");
		this.sent.push({ message, options });
		// Mirror AgentSession: a turn starts only when triggerTurn is honored.
		return options?.triggerTurn === true && this.turnStarts;
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

	agentEnd(): void {
		this.emit({ type: "agent_end", messages: [] });
	}
}

function install(session: FakeSession, overrides: Record<string, unknown> = {}): Settings {
	const settings = Settings.isolated({ "autolearn.enabled": true, ...overrides });
	new AutoLearnController({ session: session as unknown as AgentSession, settings });
	return settings;
}

interface AutoLearnSessionHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	authStorage: AuthStorage;
	tempDir: TempDir;
}

const autoLearnHarnesses: AutoLearnSessionHarness[] = [];

afterEach(async () => {
	for (const harness of autoLearnHarnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		await harness.tempDir.remove();
	}
});

function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || !("text" in block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

async function createAutoLearnSessionHarness(responses: MockResponse[]): Promise<AutoLearnSessionHarness> {
	const tempDir = TempDir.createSync("@pi-autolearn-capture-");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled anthropic model to exist");
	const mock = createMockModel({ responses });
	const sessionManager = SessionManager.inMemory();
	const settings = Settings.isolated({
		"autolearn.enabled": true,
		"autolearn.autoContinue": true,
		"compaction.enabled": false,
		"retry.enabled": false,
	});
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		}),
		sessionManager,
		settings,
		modelRegistry,
	});
	new AutoLearnController({ session, settings });
	const harness = { session, sessionManager, mock, authStorage, tempDir };
	autoLearnHarnesses.push(harness);
	return harness;
}

describe("AutoLearnController", () => {
	it("does not inject a passive nudge into the conversation prefix", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(5);
		session.agentEnd();

		expect(session.sent).toHaveLength(0);
	});

	it("the auto-continue nudge is terminal — capture then stop, never assume approval (#3504)", () => {
		// Regression: with autoContinue on, the synthetic capture turn carries
		// the nudge as its only user-role payload. Without an explicit "stop /
		// not a user reply / do not assume approval" contract, the agent reads
		// its own unanswered prior question (e.g. "Want me to commit and
		// push?") as accepted and continues — exactly the scenario in #3504.
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		const body = String(session.sent[0]?.message.content);
		// Frames the prompt as automated, not as the user's response.
		expect(body).toMatch(/not a user reply|not from the user/i);
		// Forbids inferring approval / acting on pending questions.
		expect(body).toMatch(/not.*(approval|accept|pending|prior)/i);
		// Demands a hard stop after capture, with no continuation.
		expect(body).toMatch(/then stop\./i);
		expect(body).toMatch(/do not.*(continue|resume|other tools)/i);
		expect(body).toMatch(/wait for the user'?s next prompt/i);
	});

	it("does not nudge below the threshold", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(4);
		session.agentEnd();
		expect(session.sent).toHaveLength(0);
	});

	it("does not nudge during plan mode", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(0);
	});
	it("does not combine tool calls across separate sub-threshold turns", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(3);
		session.agentEnd();
		session.toolCalls(3);
		session.agentEnd();
		// Neither turn reached the threshold; the counter must not accumulate.
		expect(session.sent).toHaveLength(0);
	});

	it("discards plan-mode tool calls instead of leaking them into the next turn", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd(); // plan mode: no fire, counter reset
		session.planEnabled = false;
		session.toolCalls(1);
		session.agentEnd(); // 1 < threshold -> no fire (no plan-mode leak)
		expect(session.sent).toHaveLength(0);
	});

	it("stops auto-continuing when autolearn is disabled mid-session", () => {
		const session = new FakeSession();
		// Enable via the global layer (not an isolated override) so the live flag
		// can be flipped and the controller's fire-time re-check is exercised.
		const settings = Settings.isolated({ "autolearn.autoContinue": true });
		settings.set("autolearn.enabled", true);
		new AutoLearnController({ session: session as unknown as AgentSession, settings });
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1); // fires while enabled
		settings.set("autolearn.enabled", false);
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1); // no new nudge after disable
		// The disabled stop must NOT leave its tool calls queued: re-enabling and
		// doing a sub-threshold turn must not fire from leaked counts.
		settings.set("autolearn.enabled", true);
		session.toolCalls(1);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});

	it("does not nudge during goal mode and leaks no suppression latch", () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		// Goal mode owns the continuation; auto-learn stays out of the loop.
		expect(session.sent).toHaveLength(0);
		// The skipped stop must not arm suppression for the next non-goal stop.
		session.goalEnabled = false;
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});

	it("never nudges a turn that started in goal mode even if the goal ended mid-turn", () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		// The turn begins as a goal continuation...
		session.agentStart();
		session.toolCalls(5);
		// ...then a `goal` tool completes/drops the goal mid-turn: the live flag is
		// off by the time the turn stops, but this turn must still never be nudged.
		session.goalEnabled = false;
		session.agentEnd();
		expect(session.sent).toHaveLength(0);

		// The capture is per-turn: a fresh turn that did not start in goal mode
		// nudges normally, proving the latch resets.
		session.agentStart();
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});

	it("auto-runs a capture turn and suppresses exactly one follow-up agent_end", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });

		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
		expect(session.sent[0]?.options?.triggerTurn).toBe(true);

		// The synthetic capture turn's agent_end is swallowed.
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);

		// Suppression is one-shot: the next qualifying stop fires again.
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(2);
	});

	it("disarms suppression when the capture turn is deferred (not started)", async () => {
		const session = new FakeSession();
		// triggerTurn honored but downgraded to a queue: no synthetic agent_end.
		session.turnStarts = false;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
		expect(session.sent[0]?.options?.triggerTurn).toBe(true);
		await Bun.sleep(1); // flush the async disarm
		// No turn ran, so the next real stop must still nudge.
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(2);
	});

	it("disarms suppression when the capture-turn dispatch fails", async () => {
		const session = new FakeSession();
		session.failSend = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd(); // dispatch rejects: armed, then disarmed in .catch
		expect(session.sent).toHaveLength(0);
		await Bun.sleep(1); // flush the async disarm
		session.failSend = false;
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});

	it("respects a custom minToolCalls threshold", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true, "autolearn.minToolCalls": 2 });
		session.toolCalls(2);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});
});

it("hides capture-turn assistant text while still clearing suppression on its agent_end", async () => {
	const { session, sessionManager, mock } = await createAutoLearnSessionHarness([
		{ content: ["First real answer"] },
		{ content: ["Second real answer"] },
	]);
	let agentEnds = 0;
	session.subscribe(event => {
		if (event.type === "agent_end") agentEnds++;
	});

	for (let i = 0; i < 5; i++) {
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: `first-${i}`,
			toolName: "read",
			result: null,
		});
	}
	const firstRealAnswer = createAssistantMessage("First real answer");
	session.agent.emitExternalEvent({ type: "message_end", message: firstRealAnswer });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [firstRealAnswer] });
	await session.waitForIdle();

	expect(mock.calls).toHaveLength(1);
	expect(agentEnds).toBe(2);
	expect(
		session.messages.filter(message => message.role === "assistant" && messageText(message) === "First real answer").length,
	).toBe(1);
	expect(
		session.buildDisplaySessionContext().messages.filter(
			message => message.role === "assistant" && messageText(message) === "First real answer",
		).length,
	).toBe(1);
	expect(
		sessionManager
			.getBranch()
			.filter(
				entry => entry.type === "message" && entry.message.role === "assistant" && messageText(entry.message) === "First real answer",
			).length,
	).toBe(1);

	for (let i = 0; i < 5; i++) {
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: `second-${i}`,
			toolName: "read",
			result: null,
		});
	}
	const secondRealAnswer = createAssistantMessage("Second real answer");
	session.agent.emitExternalEvent({ type: "message_end", message: secondRealAnswer });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [secondRealAnswer] });
	await session.waitForIdle();

	expect(mock.calls).toHaveLength(2);
	expect(agentEnds).toBe(4);
	expect(
		session.messages.filter(message => message.role === "assistant" && messageText(message) === "Second real answer").length,
	).toBe(1);
	expect(
		session.buildDisplaySessionContext().messages.filter(
			message => message.role === "assistant" && messageText(message) === "Second real answer",
		).length,
	).toBe(1);
	expect(
		sessionManager
			.getBranch()
			.filter(
				entry => entry.type === "message" && entry.message.role === "assistant" && messageText(entry.message) === "Second real answer",
			).length,
	).toBe(1);
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
