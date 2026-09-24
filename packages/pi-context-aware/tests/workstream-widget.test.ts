import test from "node:test";
import assert from "node:assert/strict";

import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";

import { createWorkstreamSnapshot } from "../workstream-state.js";
import {
	createWorkstreamFocusWidget,
	WORKSTREAM_FOCUS_COLLAPSED_LINES,
	workstreamFocusWidgetText,
} from "../workstream-widget.js";

function snapshot(overrides: Partial<Parameters<typeof createWorkstreamSnapshot>[0]> = {}) {
	return createWorkstreamSnapshot({
		workstreamId: "ws-widget",
		piSessionId: "session-widget",
		objective: "Keep the active objective visible",
		objectivePinned: true,
		now: "2026-07-29T00:00:00.000Z",
		...overrides,
	});
}

const theme = { fg: (_color: "accent", text: string) => text };

function hasTerminalControl(text: string): boolean {
	return [...text].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
}

test("active workstreams wrap within the collapsed budget with goal progress", () => {
	const current = snapshot({
		goals: [
			{ id: "done", text: "Completed setup", status: "done" },
			{ id: "active", text: "Finish the widget", status: "active" },
		],
	});
	assert.equal(
		workstreamFocusWidgetText(current),
		"🎯 Keep the active objective visible · active · 1/2 goals",
	);

	const component = createWorkstreamFocusWidget(current, theme);
	const lines = component.render(20);
	assert.equal(lines.length, WORKSTREAM_FOCUS_COLLAPSED_LINES);
	for (const line of lines) {
		assert.equal(
			truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, 20, 0).visualLines.length,
			1,
			"every collapsed line must fit the available width",
		);
	}
	assert.match(lines[0] ?? "", /^🎯/u);
	assert.match(lines[1] ?? "", /…$/u, "a clipped objective must show it was cut");
	assert.equal(lines[0]?.includes("…"), false, "wrapping must continue onto the second line");
});

test("a short objective stays on one line and never pads the collapsed budget", () => {
	const component = createWorkstreamFocusWidget(snapshot({ objective: "Ship it" }), theme);
	assert.deepEqual(component.render(80), ["🎯 Ship it · active"]);
});

test("expanding tool output lifts the line budget and appends the collapse hint", () => {
	let expanded = false;
	const component = createWorkstreamFocusWidget(snapshot({
		objective: "Wrap the persistent focus projection across every available terminal column",
	}), theme, {
		isExpanded: () => expanded,
		expandedHint: () => " tab to collapse",
	});
	const collapsed = component.render(24);
	assert.equal(collapsed.length, WORKSTREAM_FOCUS_COLLAPSED_LINES);
	assert.match(collapsed.at(-1) ?? "", /…$/u);

	expanded = true;
	const full = component.render(24);
	assert.ok(full.length > WORKSTREAM_FOCUS_COLLAPSED_LINES + 1, "expansion must reveal the whole objective");
	assert.equal(full.at(-1), " tab to collapse");
	assert.equal(full.slice(0, -1).join("").includes("…"), false, "expanded output must not be clipped");
	assert.match(full.join(" "), /every available terminal column/u);

	expanded = false;
	assert.deepEqual(component.render(24), collapsed, "collapsing must restore the bounded projection");
});

test("a disposed context callback is neutralized during render", () => {
	const component = createWorkstreamFocusWidget(snapshot(), theme, {
		isExpanded: () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	});
	assert.doesNotThrow(() => component.render(80));
	assert.deepEqual(component.render(80), ["🎯 Keep the active objective visible · active"]);
});

test("unexpected render callback errors still escape", () => {
	const component = createWorkstreamFocusWidget(snapshot(), theme, {
		isExpanded: () => { throw new Error("real render bug"); },
	});
	assert.throws(() => component.render(80), /real render bug/u);
});

test("inactive workstreams are omitted and objective controls cannot reach the terminal", () => {
	for (const status of ["paused", "completed", "detached"] as const) {
		assert.equal(workstreamFocusWidgetText(snapshot({ status })), null);
	}
	const unsafe = workstreamFocusWidgetText(snapshot({
		objective: "Safe\u001b[31m objective\nnext\u009b31m csi\u009dosc",
	}));
	assert.ok(unsafe !== null);
	assert.equal(hasTerminalControl(unsafe), false);
});

test("themed output remains ANSI-complete at narrow and zero widths", () => {
	const cyan = "\u001b[36m";
	const reset = "\u001b[39m";
	const ansiTheme = { fg: (_color: "accent", text: string) => `${cyan}${text}${reset}` };
	const component = createWorkstreamFocusWidget(snapshot(), ansiTheme);
	assert.deepEqual(component.render(0), []);
	assert.deepEqual(component.render(1), [`${cyan}…${reset}`]);
	const narrow = component.render(12);
	assert.equal(narrow.length, WORKSTREAM_FOCUS_COLLAPSED_LINES);
	for (const line of narrow) {
		assert.equal(truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, 12, 0).visualLines.length, 1);
		assert.equal(line.startsWith(cyan), true);
		assert.equal(line.endsWith(reset), true);
	}
});
