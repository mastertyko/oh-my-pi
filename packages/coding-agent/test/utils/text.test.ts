import { describe, expect, it } from "bun:test";
import { oneLineLabel } from "@oh-my-pi/pi-coding-agent/utils/text";

describe("oneLineLabel", () => {
	it("returns short text unchanged", () => {
		expect(oneLineLabel("DB migration specialist")).toBe("DB migration specialist");
	});

	it("collapses control and zero-width characters that whitespace alone misses", () => {
		const output = oneLineLabel("Auth\u0085flow\u200breviewer");
		expect(output).toBe("Auth flow reviewer");
		expect(output).not.toMatch(/[\p{Cc}\p{Cf}]/u);
	});

	it("respects a minimal cap", () => {
		expect(oneLineLabel("abcdef", 1)).toBe("…");
		expect(oneLineLabel("abcdef", 0)).toBe("…");
	});

	it("truncates on a code-point boundary", () => {
		const output = oneLineLabel(`${"a".repeat(78)}😀tail`);
		expect(output.endsWith("…")).toBe(true);
		expect(() => encodeURIComponent(output)).not.toThrow();
	});
});
