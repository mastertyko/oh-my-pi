import { describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { parseHTML } from "linkedom";
import { Marked } from "marked";

const [templateHtml, templateJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
]);

type SessionFixture = {
	header: {
		type: string;
		version: number;
		id: string;
		timestamp: string;
		cwd: string;
	};
	entries: unknown[];
	leafId: string;
};

function renderSession(session: SessionFixture) {
	const { document, window } = parseHTML(templateHtml);

	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(JSON.stringify(session)).toBase64();
	Object.defineProperty(window, "location", {
		value: new URL("https://example.test/export.html"),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});

	const context = vm.createContext({
		window,
		document,
		marked: new Marked(),
		hljs: {
			getLanguage: () => false,
			highlight: () => ({ value: "" }),
			highlightAuto: () => ({ value: "" }),
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		navigator: { clipboard: null },
		localStorage: { getItem: () => null, setItem() {} },
		setTimeout: () => 0,
		clearTimeout() {},
	});
	vm.runInContext(templateJs, context);
	return document;
}

function renderMarkdown(source: string, role: "user" | "assistant" = "user"): Element {
	const message =
		role === "user"
			? {
					role: "user",
					content: source,
					timestamp: 0,
				}
			: {
					role: "assistant",
					content: [{ type: "text", text: source }],
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				};

	const document = renderSession({
		header: {
			type: "session",
			version: 3,
			id: "markdown-test",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		},
		entries: [
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message,
			},
		],
		leafId: "message-1",
	});

	const rendered = document.querySelector(".markdown-content");
	if (!rendered) throw new Error("Export viewer did not render Markdown content");
	return rendered;
}

describe("HTML export Markdown", () => {
	test("renders inline Markdown in ordered, unordered, and nested list items", () => {
		const rendered = renderMarkdown("**outside**\n\n- **bold** and *italic* and `code`\n  1. **nested**");

		expect(rendered.querySelector("p strong")?.textContent).toBe("outside");
		expect(rendered.querySelector("ul > li > strong")?.textContent).toBe("bold");
		expect(rendered.querySelector("ul > li > em")?.textContent).toBe("italic");
		expect(rendered.querySelector("ul > li > code")?.textContent).toBe("code");
		expect(rendered.querySelector("ol > li > strong")?.textContent).toBe("nested");
	});

	test("neutralizes raw HTML tokens in user, assistant, list, table, and heading content", () => {
		const user = renderMarkdown(
			[
				"Hello <script>alert(1)</script>",
				"",
				"- item <img src=x onerror=alert(1)>",
				"",
				"# Title <b onclick=alert(1)>x</b>",
				"",
				"| a | b |",
				"| - | - |",
				"| <script>alert(1)</script> | ok |",
			].join("\n"),
		);

		expect(user.querySelector("script")).toBeNull();
		expect(user.querySelector("img")).toBeNull();
		expect(user.querySelector("b")).toBeNull();
		expect(user.innerHTML).toContain("&lt;script&gt;");
		expect(user.innerHTML).toContain("&lt;img");
		expect(user.querySelector("h1")?.textContent).toContain("<b onclick=alert(1)>x</b>");
		expect(user.querySelector("td")?.textContent).toContain("<script>alert(1)</script>");

		const assistant = renderMarkdown("assistant <iframe src=javascript:alert(1)></iframe>", "assistant");
		expect(assistant.querySelector("iframe")).toBeNull();
		expect(assistant.innerHTML).toContain("&lt;iframe");
	});

	test("rejects unsafe URL schemes while preserving safe links", () => {
		const rendered = renderMarkdown(
			[
				"[safe](https://example.com/docs)",
				"[mail](mailto:user@example.com)",
				"[js](javascript:alert(1))",
				"[data](data:text/html,hi)",
				"[vbs](vbscript:msgbox(1))",
			].join("\n\n"),
		);

		const anchors = [...rendered.querySelectorAll("a")];
		expect(anchors).toHaveLength(2);
		expect(anchors[0]?.getAttribute("href")).toBe("https://example.com/docs");
		expect(anchors[0]?.textContent).toBe("safe");
		expect(anchors[1]?.getAttribute("href")).toBe("mailto:user@example.com");
		expect(anchors[1]?.textContent).toBe("mail");

		const text = rendered.textContent ?? "";
		expect(text).toContain("js");
		expect(text).toContain("data");
		expect(text).toContain("vbs");
		expect(rendered.innerHTML).not.toContain("javascript:");
		expect(rendered.innerHTML).not.toContain("data:text/html");
		expect(rendered.innerHTML).not.toContain("vbscript:");
	});

	test("rejects control-character and HTML-entity scheme smuggling on links and images", () => {
		// Marked drops bare TAB mid-scheme links, but entity forms survive into href/src.
		// Browser attribute parsing would decode &#9;/&#x09;/&#116; into javascript:.
		const rendered = renderMarkdown(
			[
				"[safe](https://example.com/ok)",
				"[tab-entity](java&#9;script:alert(1))",
				"[hex-entity](java&#x09;script:alert(1))",
				"[letter-entity](javascrip&#116;:alert(1))",
				"![safe](https://example.com/a.png)",
				"![tab-entity](java&#9;script:alert(1))",
				"![letter-entity](javascrip&#116;:alert(1))",
				// Literal TAB mid-scheme is not a Markdown link; ensure it still does not become one.
				"[literal-tab](java\tscript:alert(1))",
			].join("\n\n"),
		);

		const anchors = [...rendered.querySelectorAll("a")];
		expect(anchors).toHaveLength(1);
		expect(anchors[0]?.getAttribute("href")).toBe("https://example.com/ok");
		expect(anchors.map(a => a.getAttribute("href"))).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/script:/i)]),
		);

		const images = [...rendered.querySelectorAll("img")];
		expect(images).toHaveLength(1);
		expect(images[0]?.getAttribute("src")).toBe("https://example.com/a.png");
		expect(images.map(img => img.getAttribute("src"))).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/script:/i)]),
		);

		// Entity-smuggled payloads must not survive as navigable attributes.
		expect(rendered.innerHTML).not.toContain("java&#9;script:");
		expect(rendered.innerHTML).not.toContain("java&#x09;script:");
		expect(rendered.innerHTML).not.toContain("javascrip&#116;:");
		// Labels still render so content is not silently dropped.
		expect(rendered.textContent).toContain("tab-entity");
		expect(rendered.textContent).toContain("letter-entity");
	});

	test("rejects named &colon; / &Colon; scheme smuggling on links and images", () => {
		// Marked leaves &colon; intact; browsers expand it to ":" in attributes.
		const rendered = renderMarkdown(
			[
				"[safe](https://example.com/ok)",
				"[colon](javascript&colon;alert(1))",
				"[Colon](javascript&Colon;alert(1))",
				"[num-colon](javascript&#58;alert(1))",
				"[hex-colon](javascript&#x3a;alert(1))",
				"![safe](https://example.com/a.png)",
				"![colon](javascript&colon;alert(1))",
				"![Colon](javascript&Colon;alert(1))",
			].join("\n\n"),
		);

		const anchors = [...rendered.querySelectorAll("a")];
		expect(anchors).toHaveLength(1);
		expect(anchors[0]?.getAttribute("href")).toBe("https://example.com/ok");
		for (const a of anchors) {
			const href = a.getAttribute("href") ?? "";
			expect(href.toLowerCase()).not.toContain("javascript");
			expect(href).not.toMatch(/&colon;/i);
		}

		const images = [...rendered.querySelectorAll("img")];
		expect(images).toHaveLength(1);
		expect(images[0]?.getAttribute("src")).toBe("https://example.com/a.png");
		for (const img of images) {
			const src = img.getAttribute("src") ?? "";
			expect(src.toLowerCase()).not.toContain("javascript");
			expect(src).not.toMatch(/&colon;/i);
		}

		// Labels still present as text (not navigable sinks).
		expect(rendered.textContent).toContain("colon");
		expect(rendered.textContent).toContain("Colon");
		// No navigable javascript&colon; attributes remain.
		expect(rendered.innerHTML).not.toMatch(/href=["'][^"']*&colon;/i);
		expect(rendered.innerHTML).not.toMatch(/src=["'][^"']*&colon;/i);
		expect(rendered.innerHTML).not.toMatch(/href=["']javascript:/i);
		expect(rendered.innerHTML).not.toMatch(/src=["']javascript:/i);
	});

	test("rejects double-encoded entity scheme smuggling on links and images", () => {
		// Single-pass decode leaves residual &colon;/&#58; that browsers finish expanding.
		const rendered = renderMarkdown(
			[
				"[safe](https://example.com/ok)",
				"[amp-colon](javascript&amp;colon;alert(1))",
				"[AMP-colon](javascript&AMP;colon;alert(1))",
				"[amp-num](javascript&amp;#58;alert(1))",
				"[amp-hex](javascript&amp;#x3a;alert(1))",
				"[amp-Colon](javascript&amp;Colon;alert(1))",
				"[data-amp](data&amp;colon;text/html,hi)",
				"[vbs-amp](vbscript&amp;colon;msgbox(1))",
				// Legitimate query ampersands must survive fixed-point decoding.
				"[query](https://example.com/search?q=1&amp;x=2)",
				"![safe](https://example.com/a.png)",
				"![amp-colon](javascript&amp;colon;alert(1))",
				"![amp-num](javascript&amp;#58;alert(1))",
				"![data-amp](data&amp;colon;text/html,hi)",
			].join("\n\n"),
		);

		const anchors = [...rendered.querySelectorAll("a")];
		const hrefs = anchors.map(a => a.getAttribute("href") ?? "");
		expect(hrefs).toContain("https://example.com/ok");
		expect(hrefs).toContain("https://example.com/search?q=1&x=2");
		for (const href of hrefs) {
			expect(href.toLowerCase()).not.toMatch(/^(?:javascript|data|vbscript):/i);
			expect(href).not.toMatch(/&colon;/i);
			expect(href).not.toMatch(/&#(?:x)?[0-9a-f]+;/i);
			expect(href).not.toMatch(/&amp;/i);
		}

		const srcs = [...rendered.querySelectorAll("img")].map(img => img.getAttribute("src") ?? "");
		expect(srcs).toContain("https://example.com/a.png");
		for (const src of srcs) {
			expect(src.toLowerCase()).not.toMatch(/^(?:javascript|data|vbscript):/i);
			expect(src).not.toMatch(/&colon;/i);
			expect(src).not.toMatch(/&#(?:x)?[0-9a-f]+;/i);
		}

		// Labels render; no residual entity-bearing unsafe attributes.
		expect(rendered.textContent).toContain("amp-colon");
		expect(rendered.innerHTML).not.toMatch(/href=["'][^"']*(?:&colon;|&amp;colon;|&#58;|&#x3a;)/i);
		expect(rendered.innerHTML).not.toMatch(/src=["'][^"']*(?:&colon;|&amp;colon;|&#58;|&#x3a;)/i);
		expect(rendered.innerHTML).not.toMatch(/href=["'](?:javascript|data|vbscript):/i);
		expect(rendered.innerHTML).not.toMatch(/src=["'](?:javascript|data|vbscript):/i);
	});

	test("hostile out-of-range numeric entities do not crash export or create unsafe attributes", () => {
		// &#x110000; is above U+10FFFF; naive String.fromCodePoint throws RangeError.
		// Rendering must complete, keep safe links, and never emit a javascript: attribute
		// even when the invalid entity sits inside a smuggled scheme.
		let rendered: Element;
		expect(() => {
			rendered = renderMarkdown(
				[
					"[safe](https://example.com/ok)",
					"[oor](https://example.com/&#x110000;path)",
					"[smuggle](java&#x110000;script:alert(1))",
					"[dec](java&#1114112;script:alert(1))",
					"![safe](https://example.com/a.png)",
					"![smuggle](java&#x110000;script:alert(1))",
				].join("\n\n"),
			);
		}).not.toThrow();

		const anchors = [...rendered!.querySelectorAll("a")];
		const hrefs = anchors.map(a => a.getAttribute("href") ?? "");
		// At least the clean safe link survives; no javascript: attributes appear.
		expect(hrefs).toContain("https://example.com/ok");
		expect(hrefs.some(h => /javascript:/i.test(h))).toBe(false);
		expect(hrefs.some(h => /script:/i.test(h))).toBe(false);

		const srcs = [...rendered!.querySelectorAll("img")].map(img => img.getAttribute("src") ?? "");
		expect(srcs).toContain("https://example.com/a.png");
		expect(srcs.some(s => /script:/i.test(s))).toBe(false);

		// Labels still present (content not swallowed by a throw mid-render).
		expect(rendered!.textContent).toContain("safe");
		expect(rendered!.textContent).toContain("smuggle");
	});

	test("rejects unsafe markdown image schemes", () => {
		const rendered = renderMarkdown("![ok](https://example.com/a.png)\n\n![bad](javascript:alert(1))");
		const images = [...rendered.querySelectorAll("img")];
		expect(images).toHaveLength(1);
		expect(images[0]?.getAttribute("src")).toBe("https://example.com/a.png");
		expect(images[0]?.getAttribute("alt")).toBe("ok");
		expect(rendered.textContent).toContain("bad");
		expect(rendered.innerHTML).not.toContain("javascript:");
	});

	test("validates and attribute-encodes session image blocks", () => {
		const document = renderSession({
			header: {
				type: "session",
				version: 3,
				id: "image-test",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			entries: [
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "see images" },
							{
								type: "image",
								mimeType: "image/png",
								data: "iVBORw0KGgo=",
							},
							{
								type: "image",
								// Breaks out of the attribute without sanitization.
								mimeType: 'image/png" onerror="alert(1)',
								data: "AAAA",
							},
							{
								type: "image",
								mimeType: "image/jpeg",
								// Non-base64 payload that could inject attributes.
								data: '"><img src=x onerror=alert(1)>',
							},
							{
								type: "image",
								mimeType: "text/html",
								data: "PGh0bWw+",
							},
						],
						timestamp: 0,
					},
				},
			],
			leafId: "message-1",
		});

		const images = [...document.querySelectorAll("img.message-image")];
		expect(images).toHaveLength(1);
		expect(images[0]?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
		expect(document.body.innerHTML).not.toContain('onerror="alert(1)"');
		expect(document.body.innerHTML).not.toContain("text/html");
		expect(document.querySelector(".markdown-content")?.textContent).toContain("see images");
	});
});
