import { describe, expect, test } from "bun:test";
import liveInstructionsTemplate from "./prompts/live-instructions.md" with { type: "text" };

describe("omp Live instructions", () => {
	test("defines multilingual turn behavior without translating technical content", () => {
		expect(liveInstructionsTemplate).toContain(`<language>
- You MUST identify the language of the user's latest clear spoken input and respond in that language.
- If the user switches languages, you MUST switch to the new language.
- An explicit request to use a particular language MUST override automatic language matching.
- You MUST preserve code, commands, file paths, API names, model names, and other technical identifiers verbatim unless the user explicitly asks you to translate them.
- If the language is genuinely ambiguous, you MUST ask a brief question about which language to use.
</language>`);
	});
});
