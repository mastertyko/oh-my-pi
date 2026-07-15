import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image, ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	computeSixelTargetDimensions,
	getCellDimensions,
	ImageProtocol,
	isWindowsTerminalPreviewSixelSupported,
	renderImage,
	setCellDimensions,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const BASE64_DUMMY = "AA==";
const SQUARE_DIMENSIONS = { widthPx: 100, heightPx: 100 };
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const ORIGINAL_TMUX = Bun.env.TMUX;

function parseKittyParam(sequence: string, key: "c" | "r" | "C"): number | null {
	const match = sequence.match(new RegExp(`${key}=(\\d+)`));
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

function parseITermWidth(sequence: string): string | null {
	const match = sequence.match(/width=([^;:]+)/);
	return match?.[1] ?? null;
}

describe("terminal image rendering", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;
	const originalGraphics = { ...getKittyGraphics() };

	beforeEach(() => {
		delete Bun.env.TMUX;
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = null;
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		setKittyGraphics(originalGraphics);
		if (ORIGINAL_TMUX === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = ORIGINAL_TMUX;
	});

	it("fits Kitty images within max width and max height while preserving aspect ratio", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(2);
	});

	it("anchors Kitty display commands before renderer-managed cursor movement", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(parseKittyParam(result?.sequence ?? "", "C")).toBe(1);
	});

	it("re-renders a cached fallback once an image protocol becomes available", () => {
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		expect(image.render(20).join("")).toContain("[Image:");

		terminal.imageProtocol = ImageProtocol.Kitty;
		const rerendered = image.render(20).join("");

		expect(rerendered).toContain("\x1b_Ga=T");
		expect(rerendered).toContain("C=1");
	});

	it("re-renders a cached image when cell dimensions change", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 10 },
			SQUARE_DIMENSIONS,
		);

		const first = image.render(20).join("");
		expect(parseKittyParam(first, "c")).toBe(10);

		setCellDimensions({ widthPx: 20, heightPx: 10 });
		const second = image.render(20).join("");

		expect(parseKittyParam(second, "c")).toBe(5);
	});

	it("re-renders a cached Kitty image when Unicode placeholder support changes", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: false });
		const budget = new ImageBudget(1, () => {});
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ budget, imageKey: "placeholder-cache", maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		const direct = image.render(20).join("");
		expect(direct).toContain("\x1b_Ga=p");

		setKittyGraphics({ unicodePlaceholders: true });
		const placeholder = image.render(20).join("");

		expect(placeholder).toContain("U=1");
		expect(placeholder).not.toBe(direct);
	});

	it("uses intrinsic image size when no bounds are provided", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS);

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(10);
	});

	it("transmits stable Kitty images in-band before placement", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			imageId: 42,
			includeTransmit: true,
		});

		expect(result).not.toBeNull();
		expect(result?.transmit).toBe(`\x1b_Ga=t,f=100,q=2,i=42;${BASE64_ONE_PIXEL_PNG}\x1b\\`);
		expect(result?.transmit).not.toContain("t=t");
	});

	it("reduces iTerm2 width when max height is the limiting bound", () => {
		terminal.imageProtocol = ImageProtocol.Iterm2;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseITermWidth(result?.sequence ?? "")).toBe("2");
		expect(result?.sequence).toContain("height=auto");
	});

	it("encodes SIXEL output when protocol is SIXEL", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const result = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		// SIXEL height is rounded DOWN to a multiple of 6 (band size) so it
		// never exceeds the caller's maxHeightCells cap. With 10px cells and
		// maxHeightCells=2, targetHeightPx=18 (not 20), rows=2 — within cap.
		expect(result?.rows).toBe(2);
		expect((result?.sequence ?? "").startsWith("\x1bP")).toBe(true);
	});

	it("keeps SIXEL reserved rows within maxHeightCells for sub-6px cell heights", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const cellWidthPx = 10;
		const maxWidthCells = 10;

		for (const cellHeightPx of [1, 3, 4, 5, 6, 10, 18] as const) {
			setCellDimensions({ widthPx: cellWidthPx, heightPx: cellHeightPx });

			for (const maxHeightCells of [1, 2, 3] as const) {
				// Use image pixels that exactly fill the max cell box so fit.columns /
				// fit.rows equal the caps (avoids aspect-ratio shrink muddying the
				// SIXEL band assertions).
				const imageDimensions = {
					widthPx: maxWidthCells * cellWidthPx,
					heightPx: maxHeightCells * cellHeightPx,
				};
				const result = renderImage(BASE64_ONE_PIXEL_PNG, imageDimensions, {
					maxWidthCells,
					maxHeightCells,
				});
				const reservedPx = maxHeightCells * cellHeightPx;
				const canEncodeBand = reservedPx >= 6;

				if (!canEncodeBand) {
					// No full SIXEL band fits inside the reserved height: fall back
					// rather than force a 6px encode that would overflow the row cap.
					expect(result).toBeNull();
					continue;
				}

				expect(result).not.toBeNull();
				expect(result?.rows ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(maxHeightCells);
				expect((result?.sequence ?? "").startsWith("\x1bP")).toBe(true);

				const target = computeSixelTargetDimensions(
					{ columns: maxWidthCells, rows: maxHeightCells },
					{ widthPx: cellWidthPx, heightPx: cellHeightPx },
				);
				expect(target).not.toBeNull();
				expect(target?.heightPx ?? 0).toBeGreaterThan(0);
				expect((target?.heightPx ?? 1) % 6).toBe(0);
				expect(target?.heightPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(reservedPx);
				expect(target?.widthPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(maxWidthCells * cellWidthPx);
				expect(result?.rows).toBe(target?.rows);
			}
		}
	});

	it("does not scale SIXEL width past the fitted column budget", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		// cellH=5 / maxRows=1 reserved only 5px — old Math.max(6, floor) path
		// forced 6px and scaled width *up*. Fall back instead of overflowing.
		setCellDimensions({ widthPx: 10, heightPx: 5 });
		expect(
			renderImage(
				BASE64_ONE_PIXEL_PNG,
				{ widthPx: 40, heightPx: 5 },
				{
					maxWidthCells: 4,
					maxHeightCells: 1,
				},
			),
		).toBeNull();

		// Two rows of 5px = 10px → encode height 6, scale width down (never up).
		const imageDimensions = { widthPx: 40, heightPx: 10 };
		const result = renderImage(BASE64_ONE_PIXEL_PNG, imageDimensions, {
			maxWidthCells: 4,
			maxHeightCells: 2,
		});
		const target = computeSixelTargetDimensions({ columns: 4, rows: 2 }, { widthPx: 10, heightPx: 5 });
		expect(result).not.toBeNull();
		expect(result?.rows).toBeLessThanOrEqual(2);
		expect(target).toEqual({ widthPx: 24, heightPx: 6, rows: 2 });
		expect(target?.widthPx ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(40);
	});

	it("handles tall, wide, and degenerate SIXEL geometry without overflowing", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		setCellDimensions({ widthPx: 10, heightPx: 18 });

		const tall = renderImage(
			BASE64_ONE_PIXEL_PNG,
			{ widthPx: 10, heightPx: 1000 },
			{
				maxWidthCells: 5,
				maxHeightCells: 3,
			},
		);
		expect(tall).not.toBeNull();
		expect(tall?.rows).toBeLessThanOrEqual(3);

		const wide = renderImage(
			BASE64_ONE_PIXEL_PNG,
			{ widthPx: 1000, heightPx: 10 },
			{
				maxWidthCells: 8,
				maxHeightCells: 4,
			},
		);
		expect(wide).not.toBeNull();
		expect(wide?.rows).toBeLessThanOrEqual(4);

		// Non-positive / non-finite geometry is rejected by the SIXEL path.
		expect(computeSixelTargetDimensions({ columns: 4, rows: 2 }, { widthPx: 10, heightPx: 0 })).toBeNull();
		expect(computeSixelTargetDimensions({ columns: 4, rows: 2 }, { widthPx: 0, heightPx: 18 })).toBeNull();
		expect(computeSixelTargetDimensions({ columns: 0, rows: 2 }, { widthPx: 10, heightPx: 18 })).toBeNull();
		expect(computeSixelTargetDimensions({ columns: 4, rows: 0 }, { widthPx: 10, heightPx: 18 })).toBeNull();
		expect(computeSixelTargetDimensions({ columns: Number.NaN, rows: 2 }, { widthPx: 10, heightPx: 18 })).toBeNull();
		expect(computeSixelTargetDimensions({ columns: 4, rows: Number.NaN }, { widthPx: 10, heightPx: 18 })).toBeNull();
		expect(computeSixelTargetDimensions({ columns: 4, rows: 2 }, { widthPx: Number.NaN, heightPx: 18 })).toBeNull();
		expect(computeSixelTargetDimensions({ columns: 4, rows: 2 }, { widthPx: 10, heightPx: Number.NaN })).toBeNull();
		expect(
			computeSixelTargetDimensions({ columns: Number.POSITIVE_INFINITY, rows: 2 }, { widthPx: 10, heightPx: 18 }),
		).toBeNull();
		expect(
			computeSixelTargetDimensions({ columns: 4, rows: Number.POSITIVE_INFINITY }, { widthPx: 10, heightPx: 18 }),
		).toBeNull();
		expect(
			computeSixelTargetDimensions({ columns: 4, rows: 2 }, { widthPx: Number.POSITIVE_INFINITY, heightPx: 18 }),
		).toBeNull();
		expect(
			computeSixelTargetDimensions({ columns: 4, rows: 2 }, { widthPx: 10, heightPx: Number.POSITIVE_INFINITY }),
		).toBeNull();

		// Fractional positive cell sizes are kept; fit columns/rows floor to whole cells.
		expect(computeSixelTargetDimensions({ columns: 4.8, rows: 2.9 }, { widthPx: 10.5, heightPx: 18.5 })).toEqual({
			widthPx: 41,
			heightPx: 36,
			rows: 2,
		});
	});

	it("moves back up before multi-row direct Kitty output and restores the cursor below it", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 3 },
			SQUARE_DIMENSIONS,
		);

		const lines = image.render(20);
		const imageLine = lines.at(-1) ?? "";

		expect(lines).toHaveLength(3);
		expect(lines.slice(0, -1)).toEqual(["\x1b[0m", "\x1b[0m"]);
		expect(imageLine.startsWith("\x1b7\x1b[2A")).toBe(true);
		expect(imageLine).toContain("\x1b_Ga=T");
		expect(imageLine).toContain("C=1");
		expect(imageLine).toContain("c=3");
		expect(imageLine).toContain("r=3");
		expect(imageLine.endsWith("\x1b8")).toBe(true);
	});

	it("does not emit cursor movement around single-row direct Kitty output", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 1 },
			SQUARE_DIMENSIONS,
		);

		const lines = image.render(20);
		const imageLine = lines.at(-1) ?? "";

		expect(lines).toHaveLength(1);
		expect(imageLine.startsWith("\x1b_Ga=T")).toBe(true);
		expect(imageLine).toContain("C=1");
		expect(imageLine).toContain("c=1");
		expect(imageLine).toContain("r=1");
		expect(imageLine.endsWith("\x1b\\")).toBe(true);
		expect(imageLine).not.toContain("\x1b[0A");
		expect(imageLine).not.toContain("\x1b[0B");
		expect(imageLine).not.toMatch(/\x1b\[\d+[AB]/);
	});
});

describe("Windows Terminal Preview SIXEL detection", () => {
	it("requires Windows platform, WT session, and known version 1.22+", () => {
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"win32",
			),
		).toBe(true);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.21.0.0" },
				"win32",
			),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported({ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal" }, "win32"),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"linux",
			),
		).toBe(false);
	});
});
