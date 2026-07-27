/** Preferred response languages exposed for Codex-backed realtime sessions. */
export const LIVE_LANGUAGE_OPTIONS = [
	{
		value: "auto",
		label: "Auto",
		description: "Follow explicit language requests and substantive user speech",
	},
	{ value: "af", label: "Afrikaans" },
	{ value: "ar", label: "Arabic" },
	{ value: "hy", label: "Armenian" },
	{ value: "az", label: "Azerbaijani" },
	{ value: "be", label: "Belarusian" },
	{ value: "bs", label: "Bosnian" },
	{ value: "bg", label: "Bulgarian" },
	{ value: "ca", label: "Catalan" },
	{ value: "zh", label: "Chinese" },
	{ value: "hr", label: "Croatian" },
	{ value: "cs", label: "Czech" },
	{ value: "da", label: "Danish" },
	{ value: "nl", label: "Dutch" },
	{ value: "en", label: "English" },
	{ value: "et", label: "Estonian" },
	{ value: "fi", label: "Finnish" },
	{ value: "fr", label: "French" },
	{ value: "gl", label: "Galician" },
	{ value: "de", label: "German" },
	{ value: "el", label: "Greek" },
	{ value: "he", label: "Hebrew" },
	{ value: "hi", label: "Hindi" },
	{ value: "hu", label: "Hungarian" },
	{ value: "is", label: "Icelandic" },
	{ value: "id", label: "Indonesian" },
	{ value: "it", label: "Italian" },
	{ value: "ja", label: "Japanese" },
	{ value: "kn", label: "Kannada" },
	{ value: "kk", label: "Kazakh" },
	{ value: "ko", label: "Korean" },
	{ value: "lv", label: "Latvian" },
	{ value: "lt", label: "Lithuanian" },
	{ value: "mk", label: "Macedonian" },
	{ value: "ms", label: "Malay" },
	{ value: "mr", label: "Marathi" },
	{ value: "mi", label: "Maori" },
	{ value: "ne", label: "Nepali" },
	{ value: "no", label: "Norwegian" },
	{ value: "fa", label: "Persian" },
	{ value: "pl", label: "Polish" },
	{ value: "pt", label: "Portuguese" },
	{ value: "ro", label: "Romanian" },
	{ value: "ru", label: "Russian" },
	{ value: "sr", label: "Serbian" },
	{ value: "sk", label: "Slovak" },
	{ value: "sl", label: "Slovenian" },
	{ value: "es", label: "Spanish" },
	{ value: "sw", label: "Swahili" },
	{ value: "sv", label: "Swedish" },
	{ value: "tl", label: "Tagalog" },
	{ value: "ta", label: "Tamil" },
	{ value: "th", label: "Thai" },
	{ value: "tr", label: "Turkish" },
	{ value: "uk", label: "Ukrainian" },
	{ value: "ur", label: "Urdu" },
	{ value: "vi", label: "Vietnamese" },
	{ value: "cy", label: "Welsh" },
] as const;

/** Accepted values for the live language setting. */
export type LiveLanguage = (typeof LIVE_LANGUAGE_OPTIONS)[number]["value"];

/** Accepted values exposed to the settings schema. */
export const LIVE_LANGUAGE_VALUES = LIVE_LANGUAGE_OPTIONS.map(({ value }) => value);

/** Language behavior used when no preference is configured. */
export const DEFAULT_LIVE_LANGUAGE: LiveLanguage = "auto";

/** Human-readable language name used in realtime instructions. */
export function getLiveLanguageName(language: LiveLanguage): string {
	const option = LIVE_LANGUAGE_OPTIONS.find(candidate => candidate.value === language);
	if (!option) throw new Error(`Unsupported live language: ${language}`);
	return option.label;
}
