/**
 * How a `load_skill` result looks in Pi's interactive transcript.
 *
 * A loaded skill is often hundreds of lines. The model needs every one of
 * them; the person watching mostly needs to know which skill loaded and from
 * where. So a delivered body collapses to one summary line, and ctrl+o
 * expands it to the full text. Everything else `load_skill` returns (the
 * already-loaded pointer, an unknown name, an unreadable file) is short and
 * worth reading, so it is always shown in full.
 *
 * This is rendering only. The tool result's `content`, which is what the model
 * sees, is built by `execute` and never touched here.
 *
 * Every emitted line goes through `buildPreviewLines`, which wraps to the
 * render width: pi-tui throws when a line is wider than the terminal (see
 * `platform/preview-lines.ts`).
 */

import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";

import { buildPreviewLines } from "../platform/preview-lines.js";

/** The fields of a tool result this renderer reads. */
export interface LoadSkillRenderInput {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
	readonly details?: unknown;
}

/** A pi-tui component, reduced to what the tool row calls. */
export interface LoadSkillResultComponent {
	render(width: number): string[];
	invalidate(): void;
}

/** The details `execute` attaches to a delivered body, and only to one. */
interface BodyDetails {
	readonly name: string;
	readonly path: string;
	readonly bytes: number;
	readonly lines?: number;
	readonly shadowed?: readonly string[];
	readonly changed?: boolean;
}

function bodyDetails(details: unknown): BodyDetails | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const d = details as Record<string, unknown>;
	// A pointer also carries name and path, but never bytes; an error carries
	// `error`. Only a delivered body has all three and no error.
	if (typeof d.name !== "string" || typeof d.path !== "string" || typeof d.bytes !== "number") return undefined;
	if (d.error !== undefined || d.pointer !== undefined) return undefined;
	return d as unknown as BodyDetails;
}

function resultText(result: LoadSkillRenderInput): string {
	return result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

/** The one collapsed line for a delivered body, before styling. */
export function loadSkillSummary(details: BodyDetails): string {
	const parts = [`Loaded skill "${details.name}"`, details.path];
	if (typeof details.lines === "number") parts.push(`${details.lines} ${details.lines === 1 ? "line" : "lines"}`);
	if (details.changed === true) parts.push("changed since the last load");
	const shadowed = details.shadowed?.length ?? 0;
	if (shadowed > 0) parts.push(`shadows ${shadowed} other ${shadowed === 1 ? "copy" : "copies"}`);
	return parts.join(" · ");
}

function styled(theme: Theme | undefined, color: "toolOutput" | "muted", text: string): string {
	if (!theme) return text;
	return text
		.split("\n")
		.map((line) => theme.fg(color, line))
		.join("\n");
}

/**
 * Render one `load_skill` result. `theme` is the one Pi passes to
 * `renderResult`; without it the text is left unstyled.
 */
export function renderLoadSkillResult(
	result: LoadSkillRenderInput,
	options: { readonly expanded: boolean },
	theme?: Theme,
): LoadSkillResultComponent {
	const text = resultText(result);
	const body = bodyDetails(result.details);
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
			const collapse = body !== undefined && !options.expanded;
			cachedLines = collapse
				? buildPreviewLines({
						body: `${styled(theme, "muted", loadSkillSummary(body))} (${keyHint("app.tools.expand", "to expand")})`,
						maxBodyLines: Number.MAX_SAFE_INTEGER,
						width,
						bodyPadding: 0,
					})
				: buildPreviewLines({
						body: styled(theme, "toolOutput", text),
						maxBodyLines: Number.MAX_SAFE_INTEGER,
						width,
						bodyPadding: 0,
					});
			cachedWidth = width;
			return cachedLines;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}
