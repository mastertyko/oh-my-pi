import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, renderLiveInstructions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext(): InteractiveModeContext {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
	};
	return {
		settings: Settings.isolated({ "live.language": "sv", "live.voice": "vale" }),
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
		const controller = new LiveCommandController(ctx, options => {
			receivedLanguage = options.language;
			receivedVoice = options.voice;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(receivedLanguage).toBe("sv");
			expect(receivedVoice).toBe("vale");
		} finally {
			await controller.stop();
		}
	});

	it("renders automatic language following for substantive speech and explicit switches", () => {
		const instructions = renderLiveInstructions("auto");

		expect(instructions).toContain("first substantive utterance");
		expect(instructions).toContain("switch immediately when the user explicitly requests another language");
		expect(instructions).toContain("substantive utterance in it");
		expect(instructions).not.toContain("is the preferred response language");
	});

	it("renders the selected language as the persistent preference", () => {
		const instructions = renderLiveInstructions("sv");

		expect(instructions).toContain("Swedish is the preferred response language");
		expect(instructions).toContain("regardless of the language the user speaks");
		expect(instructions).toContain("switch only when the user explicitly requests another language");
		expect(instructions).not.toContain("first substantive utterance");
	});
});
