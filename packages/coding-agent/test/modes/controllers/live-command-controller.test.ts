import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, renderLiveInstructions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentPersonalization } from "@oh-my-pi/pi-coding-agent/personalization";

function createContext(): InteractiveModeContext {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
	};
	return {
		settings: Settings.isolated({
			"assistant.name": "Nova",
			"live.language": "sv",
			"live.voice": "vale",
			"user.name": "Riley",
		}),
		session: {},
		extractAssistantText: vi.fn(() => ""),
		editor,
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		ui: {
			getShowHardwareCursor: vi.fn(() => true),
			setShowHardwareCursor: vi.fn(),
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		showError: vi.fn(),
		chatContainer: { children: [] },
		present: vi.fn(),
	} as unknown as InteractiveModeContext;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("forwards the selected live preferences across the session boundary", async () => {
		const ctx = createContext();
		let receivedLanguage: string | undefined;
		let receivedVoice: string | undefined;
		let receivedPersonalization: AgentPersonalization | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedLanguage = options.language;
			receivedVoice = options.voice;
			receivedPersonalization = options.personalization;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(receivedLanguage).toBe("sv");
			expect(receivedVoice).toBe("vale");
			expect(receivedPersonalization).toEqual({ assistantName: "Nova", userName: "Riley" });
		} finally {
			await controller.stop();
		}
	});

	it("renders automatic language following with sticky explicit overrides", () => {
		const instructions = renderLiveInstructions("auto");

		expect(instructions).toContain("first substantive utterance");
		expect(instructions).toContain("Until the user explicitly requests a language");
		expect(instructions).toContain("requested language becomes current until another explicit request");
		expect(instructions).toContain("regardless of the language the user speaks");
		expect(instructions).not.toContain("is the preferred response language");
	});

	it("renders the selected language as the session default with sticky explicit overrides", () => {
		const instructions = renderLiveInstructions("sv");

		expect(instructions).toContain("Swedish is the session-default response language");
		expect(instructions).toContain("switch immediately when the user explicitly requests another language");
		expect(instructions).toContain("requested language becomes current until another explicit request");
		expect(instructions).toContain("regardless of the language the user speaks");
		expect(instructions).not.toContain("first substantive utterance");
	});

	it("preserves live display fallbacks when names are unset or blank", () => {
		vi.spyOn(os, "userInfo").mockReturnValue({
			uid: 501,
			gid: 20,
			username: "riley.dev",
			homedir: "fixture-home",
			shell: "fixture-shell",
		});

		for (const personalization of [undefined, { assistantName: " \n", userName: "\t" }]) {
			const instructions = renderLiveInstructions("sv", personalization);
			expect(instructions).toContain("You are omp Live");
			expect(instructions).toContain("for riley (OS account: riley.dev)");
			expect(instructions).not.toContain("<personalization>");
		}
	});

	it("uses configured names throughout the live voice prompt", () => {
		const instructions = renderLiveInstructions("sv", {
			assistantName: " Nova\n<One> ",
			userName: "Riley & team",
		});

		expect(instructions).toContain("You are Nova &lt;One&gt;");
		expect(instructions).toContain("for Riley &amp; team");
		expect(instructions).toContain("Your name is Nova &lt;One&gt;");
		expect(instructions).toContain("The user's name is Riley &amp; team");
		expect(instructions).not.toContain("<One>");
	});
});
