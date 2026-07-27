import { describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("SelectorController prompt-affecting settings", () => {
	it("refreshes the active prompt when xdev docs mode changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("tools.xdevDocs", "catalog");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("refreshes the active prompt when either personalization name changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("assistant.name", "Nova");
		controller.handleSettingChange("user.name", "Riley");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(2);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("surfaces personalization prompt refresh failures", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {
			throw new Error("refresh failed");
		});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("assistant.name", "Nova");
		await Promise.resolve();
		await Promise.resolve();

		expect(ctx.showError).toHaveBeenCalledWith("Failed to apply personalization: Error: refresh failed");
	});
});
