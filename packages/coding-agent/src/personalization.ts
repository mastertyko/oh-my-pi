import { escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import personalizationTemplate from "./prompts/system/personalization.md" with { type: "text" };
import { oneLineLabel } from "./utils/text";

/** Optional names used to personalize every provider-facing agent prompt. */
export interface AgentPersonalization {
	assistantName?: string;
	userName?: string;
}

function normalizeName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return oneLineLabel(value) || undefined;
}

/** Normalized names and their shared provider-facing prompt block. */
export interface RenderedAgentPersonalization extends AgentPersonalization {
	prompt: string;
}

/** Normalizes names once while rendering the shared text/live contract. */
export function renderAgentPersonalization(
	personalization: AgentPersonalization | undefined,
): RenderedAgentPersonalization | undefined {
	if (!personalization) return undefined;
	const assistantName = normalizeName(personalization.assistantName);
	const userName = normalizeName(personalization.userName);
	if (!assistantName && !userName) return undefined;
	const renderedPrompt = prompt
		.render(personalizationTemplate, {
			assistantName: assistantName ? escapeXmlText(assistantName) : "",
			userName: userName ? escapeXmlText(userName) : "",
		})
		.trim();
	return { assistantName, userName, prompt: renderedPrompt };
}
