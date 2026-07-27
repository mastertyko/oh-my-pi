const ONE_LINE_LABEL_MAX = 80;

/**
 * Collapse whitespace, control, and format runs to one space, then cap by
 * Unicode code point. Truncation reserves the final code point for an ellipsis.
 */
export function oneLineLabel(text: string, max = ONE_LINE_LABEL_MAX): string {
	const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const cap = Math.max(1, max);
	if (oneLine.length <= cap) return oneLine;
	const chars = [...oneLine];
	return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : oneLine;
}
