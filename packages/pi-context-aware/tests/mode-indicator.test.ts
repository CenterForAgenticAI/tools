import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { supportsContextAwareModeUiV1, type ContextAwareModeDefinitionV1, type ContextAwareModeSnapshotV1, type ContextAwareServiceV1 } from "../src/context-service.js";
import { MODES_WIDGET_KEY, renderModeIndicatorLine } from "../src/modes/mode-indicator.js";
import { createModesExtensionController } from "../src/modes/modes-extension.js";
import { createContextAwareModesV1, MODE_STATE_ENTRY_TYPE } from "../src/modes/modes-runtime.js";

const themeModule = await import(pathToFileURL(path.join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")).href) as {
	initTheme: (themeName?: string, enableWatcher?: boolean) => void;
	theme: Theme;
};
themeModule.initTheme(undefined, false);
const theme = themeModule.theme;

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "gu"), "");

function runtime(entries: unknown[] = []) {
	return createContextAwareModesV1({
		appendEntry: (customType, data) => { entries.push({ type: "custom", customType, data }); },
		sendMessage: () => {},
		entries: () => entries,
	});
}

function definition(id: string, extra: Partial<ContextAwareModeDefinitionV1> = {}): ContextAwareModeDefinitionV1 {
	return { id, owner: "indicator-test", transition: `${id} is active.`, blockedTools: [], ...extra };
}

function snapshot(id: string, extra: Partial<ContextAwareModeSnapshotV1> = {}): ContextAwareModeSnapshotV1 {
	return { id, owner: "pi-stack", available: true, enteredAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...extra };
}

test("a mode definition keeps only an accepted ui color and label", async () => {
	const entries: unknown[] = [];
	const modes = runtime(entries);
	const ui = { color: "#FF0080", label: "Planning" };
	Object.defineProperty(ui, "secret", { enumerable: true, get: () => { throw new Error("secret getter was read"); } });
	const defined = modes.defineMode(definition("plan", { ui: ui as ContextAwareModeDefinitionV1["ui"] }));
	assert.equal(defined.status, "ok");
	if (defined.status !== "ok") return;
	assert.deepEqual(await defined.handle.enter(), { status: "ok" });
	assert.deepEqual(modes.current()?.ui, { color: "#ff0080", label: "Planning" });
	ui.label = "Changed by caller";
	assert.equal(modes.current()?.ui?.label, "Planning", "the caller's object must not stay live");
	const state = entries.find((entry) => (entry as { customType?: unknown }).customType === MODE_STATE_ENTRY_TYPE);
	assert.doesNotMatch(JSON.stringify(state), /ff0080|Planning/iu, "state entries carry no definition data");

	for (const [label, bad] of [
		["unknown token", { color: "red" }],
		["short hex", { color: "#f08" }],
		["background token", { color: "selectedBg" }],
		["escape in label", { label: `${ESC}[31mred` }],
		["newline in label", { label: "two\nlines" }],
		["bidi override in label", { label: "a\u202eb" }],
		["long label", { label: "x".repeat(33) }],
		["empty label", { label: "  " }],
		["array", ["accent"]],
	] as const) {
		const refused = modes.defineMode(definition(`bad-${label.replaceAll(" ", "-")}`, { ui: bad as unknown as ContextAwareModeDefinitionV1["ui"] }));
		assert.equal(refused.status, "refused", label);
	}
	assert.equal(modes.defineMode(definition("tokens", { ui: { color: "warning", label: "x".repeat(32) } })).status, "ok");
});

test("a replayed mode shows no ui until its owner defines it again", async () => {
	const entries: unknown[] = [];
	const first = runtime(entries);
	const defined = first.defineMode(definition("plan", { ui: { color: "success" } }));
	assert.equal(defined.status, "ok");
	if (defined.status !== "ok") return;
	await defined.handle.enter();
	const resumed = runtime(entries);
	assert.equal(resumed.current()?.available, false);
	assert.equal(resumed.current()?.ui, undefined);
	resumed.defineMode(definition("plan", { ui: { color: "error" } }));
	assert.deepEqual(resumed.current()?.ui, { color: "error" });
});

test("supportsContextAwareModeUiV1 needs the ui flag on a modes capability", () => {
	const modes = { defineMode: () => ({ status: "refused" as const, code: "INVALID_REQUEST" as const, message: "" }), current: () => null, setSuggestionConfirmer: () => {} };
	const service = (extra: object) => ({ protocolVersion: 1, modes: { ...modes, ...extra } }) as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareModeUiV1(service({ ui: true })), true);
	assert.equal(supportsContextAwareModeUiV1(service({ toolPolicies: true })), false);
	assert.equal(supportsContextAwareModeUiV1(service({ ui: "yes" })), false);
	assert.equal(supportsContextAwareModeUiV1({ protocolVersion: 1, modes: { ui: true } } as unknown as ContextAwareServiceV1), false);
});

test("the indicator paints the mode chip and rule in the mode's own color", () => {
	const pink = { kind: "rgb", r: 255, g: 0, b: 128 } as const;
	const line = renderModeIndicatorLine([snapshot("plan", { ui: { color: "#ff0080", label: "Plan" } })], theme, 60);
	assert.equal(visibleWidth(line), 60);
	assert.ok(line.includes(theme.style(" ◆ Plan ", { fg: pink, inverse: true, bold: true })), "chip uses the mode color, inverted");
	const pinkStart = theme.style("X", { fg: pink }).split("X")[0] ?? "";
	assert.ok(pinkStart.length > 0 && line.includes(`${pinkStart} ─`), "rule uses the mode color");
	assert.match(stripAnsi(line), /^ ◆ Plan {2}· pi-stack ─+$/u);

	const token = renderModeIndicatorLine([snapshot("review")], theme, 40);
	assert.ok(token.includes(theme.style(" ◆ review ", { fg: "accent", inverse: true, bold: true })), "no ui falls back to accent");
	assert.ok(!token.includes(theme.style(" ◆ review ", { fg: "warning", inverse: true, bold: true })));
});

test("the indicator draws one chip per layer in the given order, with availability, pin and model provenance", () => {
	const modes = [
		snapshot("role", { layer: "role", rank: 0, pinned: true, owner: "pi-launch", ui: { color: "mdLink", label: "Builder" } }),
		snapshot("plan", { layer: "stage", rank: 1, available: false, ui: { color: "success", label: "Plan" } }),
		snapshot("review", { layer: "stance", rank: 2, ui: { color: "warning" }, suggestedBy: "model" }),
	];
	const line = renderModeIndicatorLine(modes, theme, 120);
	assert.match(stripAnsi(line), /^ ◆ Builder ⚑ {3}◆ Plan \(unavailable\) {3}◆ review {2}· pi-launch, pi-stack \[model-confirmed\] ─+$/u);
	assert.ok(line.includes(theme.style(" ◆ Plan (unavailable) ", { fg: "muted", inverse: true, bold: true })), "an unavailable mode loses its color");
	assert.ok(line.includes(theme.style(" ◆ review ", { fg: "warning", inverse: true, bold: true })));
	const warningStart = theme.style("X", { fg: "warning" }).split("X")[0] ?? "";
	assert.ok(line.includes(`${warningStart} ─`), "the rule takes the top layer's color");
});

test("the indicator draws the trail after the chips and owners", () => {
	const modes = [snapshot("plan", { layer: "stage", rank: 1 }), snapshot("review", { layer: "stance", rank: 2 })];
	const line = stripAnsi(renderModeIndicatorLine(modes, theme, 120, "build 2/5"));
	assert.match(line, /^ ◆ plan {3}◆ review {2}· pi-stack › build 2\/5 ─+$/u);
	assert.doesNotMatch(stripAnsi(renderModeIndicatorLine(modes, theme, 120)), /›/u, "no trail, no separator");
	assert.equal(renderModeIndicatorLine([], theme, 120), "", "no layer draws nothing");
});

test("the indicator fits any width", () => {
	const modes = [snapshot("outer-mode", { layer: "stage", rank: 1 }), snapshot("a-very-long-mode-identifier", { layer: "stance", rank: 2 })];
	for (const width of [1, 2, 7, 33, 200]) assert.equal(visibleWidth(renderModeIndicatorLine(modes, theme, width, "trail")), width, `width ${width}`);
	assert.equal(renderModeIndicatorLine(modes, theme, 0), "");
});

type WidgetCall = [key: string, value: unknown, options: unknown];

test("the indicator draws a mode id, owner and trail without their control characters", () => {
	const modes = [snapshot(`outer${ESC}[H`), snapshot(`plan${ESC}[2J`, { owner: `evil\n${ESC}]0;title\u0007owner\u202e` })];
	const line = renderModeIndicatorLine(modes, theme, 160, `step${ESC}[3J`);
	const visible = stripAnsi(line);
	assert.ok(!line.includes(`${ESC}[2J`) && !line.includes(`${ESC}[H`) && !line.includes(`${ESC}]0;`) && !line.includes(`${ESC}[3J`), "no raw escape from id, owner or trail reaches the line");
	assert.doesNotMatch(visible, /[\p{Cc}\p{Cf}]/u, "only the theme's own color codes remain");
	assert.match(visible, /^ ◆ outer\uFFFD\[H {3}◆ plan\uFFFD\[2J {2}· pi-stack, evil\uFFFD\uFFFD\]0;title\uFFFDowner\uFFFD › step\uFFFD\[3J ─+$/u);
});

test("on a theme without style, the indicator keeps the theme token and bold but drops fixed colors", () => {
	const calls: string[] = [];
	const plain = {
		fg: (token: string, text: string) => { calls.push(token); return `<${token}>${text}</>`; },
		bold: (text: string) => `*${text}*`,
	} as unknown as Theme;
	const hex = renderModeIndicatorLine([snapshot("plan", { ui: { color: "#ff0080", label: "Plan" } })], plain, 200);
	assert.ok(hex.startsWith("*<accent> ◆ Plan </>*"), "a fixed color falls back to accent, still bold");
	const token = renderModeIndicatorLine([snapshot("review", { ui: { color: "warning" } })], plain, 200);
	assert.ok(token.startsWith("*<warning> ◆ review </>*"), "a theme token is kept");
	assert.ok(token.includes("<warning> ─"), "the rule keeps the token, without bold");
	assert.ok(!calls.includes("#ff0080"), "no hex color is passed to fg");
});

function controllerHarness() {
	const entries: unknown[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		sendMessage: () => {},
		on: () => {},
		registerCommand: () => {},
		registerTool: () => {},
	} as unknown as ExtensionAPI;
	const controller = createModesExtensionController(pi, { suggestToolEnabled: () => true });
	const context = () => {
		const widgets: WidgetCall[] = [];
		const statuses: unknown[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (_key: string, value: unknown) => { statuses.push(value); },
				setWidget: (key: string, value: unknown, options?: unknown) => { widgets.push([key, value, options]); },
			},
			sessionManager: { getBranch: () => entries },
		} as unknown as ExtensionContext;
		return { ctx, widgets, statuses };
	};
	return { controller, context, entries };
}

function renderWidget(call: WidgetCall | undefined, width = 60): string[] | undefined {
	if (call === undefined || call[1] === undefined) return undefined;
	const component = (call[1] as (tui: unknown, theme: Theme) => { render(width: number): string[] })(undefined, theme);
	return component.render(width).map(stripAnsi);
}

test("the controller shows the indicator below the editor and clears it on exit and shutdown", async () => {
	const { controller, context, entries } = controllerHarness();
	const first = context();
	controller.start(first.ctx);
	const modes = controller.capability();
	assert.ok(modes);
	assert.equal(modes.ui, true);
	assert.equal(modes.layered, true);
	const outer = modes.defineMode(definition("plan", { ui: { color: "success", label: "Plan" }, layer: { name: "stage", rank: 1 } }));
	const inner = modes.defineMode(definition("review", { ui: { color: "#ff0080" }, layer: { name: "stance", rank: 2 } }));
	assert.ok(outer.status === "ok" && inner.status === "ok");
	const before = first.widgets.length;
	modes.defineMode(definition("unrelated"));
	assert.equal(first.widgets.length, before, "defining an inactive mode does not redraw");

	await outer.handle.enter();
	assert.deepEqual(first.widgets.at(-1)?.[2], { placement: "belowEditor" });
	assert.equal(first.widgets.at(-1)?.[0], MODES_WIDGET_KEY);
	assert.match(renderWidget(first.widgets.at(-1))?.[0] ?? "", /^ ◆ Plan {2}· indicator-test ─+$/u);
	await inner.handle.enter();
	assert.match(renderWidget(first.widgets.at(-1))?.[0] ?? "", /^ ◆ Plan {3}◆ review {2}· indicator-test/u);
	assert.equal(first.statuses.at(-1), "mode: stage: plan · owner: indicator-test | stance: review · owner: indicator-test");
	const drawn = first.widgets.length;
	assert.deepEqual(modes.setTrail?.("build 2/5"), { status: "ok" });
	assert.equal(first.widgets.length, drawn + 1, "a new trail redraws");
	assert.match(renderWidget(first.widgets.at(-1), 80)?.[0] ?? "", / › build 2\/5 ─/u);
	modes.setTrail?.("build 2/5");
	assert.equal(first.widgets.length, drawn + 1, "the same trail does not redraw");
	assert.equal(modes.setTrail?.(`bad${ESC}[2J`).status, "refused", "a trail with a control character is refused");
	assert.equal(modes.setTrail?.("x".repeat(65)).status, "refused", "a trail over 64 characters is refused");
	assert.match(renderWidget(first.widgets.at(-1), 80)?.[0] ?? "", / › build 2\/5 ─/u, "a refused trail keeps the old one");
	modes.setTrail?.(undefined);
	assert.doesNotMatch(renderWidget(first.widgets.at(-1), 80)?.[0] ?? "", /›/u);
	assert.doesNotMatch(JSON.stringify(entries), /build 2/u, "the trail is never persisted");
	inner.handle.exit();
	assert.match(renderWidget(first.widgets.at(-1))?.[0] ?? "", /^ ◆ Plan /u);
	outer.handle.exit();
	assert.equal(first.widgets.at(-1)?.[1], undefined, "no mode clears the widget");

	await outer.handle.enter();
	const replacement = context();
	controller.start(replacement.ctx);
	assert.match(renderWidget(replacement.widgets.at(-1))?.[0] ?? "", /^ ◆ plan \(unavailable\) /u, "a new context gets the replayed mode");
	controller.shutdown(replacement.ctx);
	assert.deepEqual(replacement.widgets.at(-1)?.slice(0, 2), [MODES_WIDGET_KEY, undefined]);
});

test("the footer status draws a mode id and owner without their control characters", async () => {
	const { controller, context } = controllerHarness();
	const session = context();
	controller.start(session.ctx);
	const modes = controller.capability();
	assert.ok(modes);
	const defined = modes.defineMode({ ...definition(`plan${ESC}[2J`), owner: `evil\n${ESC}[31mowner` });
	assert.equal(defined.status, "ok");
	if (defined.status !== "ok") return;
	await defined.handle.enter();
	assert.equal(session.statuses.at(-1), "mode: plan\uFFFD[2J · owner: evil\uFFFD\uFFFD[31mowner");
});
