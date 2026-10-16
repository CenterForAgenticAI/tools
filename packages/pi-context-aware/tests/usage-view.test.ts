import test from "node:test";
import assert from "node:assert/strict";
import {
	contextPressureVerdict,
	measuredUsage,
	usageView,
	workerTurnSizeFields,
	type MeasuredUsageView,
} from "../src/compaction/usage-view.js";

function reserve(safe: boolean): { check: (measured: MeasuredUsageView) => boolean; calls: number[] } {
	const calls: number[] = [];
	return {
		calls,
		check: (measured) => {
			calls.push(measured.tokens);
			return safe;
		},
	};
}

test("an unreported size is unmeasured and carries only the pending estimate", () => {
	const u = usageView(null, 200_000, 1_500);
	assert.equal(u.unmeasured, true);
	assert.equal(u.tokens, 1_500);
	assert.equal(measuredUsage(u), null);
	assert.equal(measuredUsage(usageView(undefined, 200_000)), null);
});

test("a reported size is measured and adds the pending estimate", () => {
	assert.deepEqual(measuredUsage(usageView(150_000, 200_000, 2_000)), {
		tokens: 152_000,
		window: 200_000,
		fraction: 0.76,
		headroom: 48_000,
	});
});

test("a reported size of zero is a measurement, not an unknown size", () => {
	assert.deepEqual(measuredUsage(usageView(0, 100_000)), { tokens: 0, window: 100_000, fraction: 0, headroom: 100_000 });
});

test("an unmeasured or missing size has an unknown verdict and never consults the reserve", () => {
	const unsafe = reserve(false);
	assert.equal(contextPressureVerdict(usageView(null, 200_000), 0.78, unsafe.check), "unknown");
	assert.equal(contextPressureVerdict(null, 0.78, unsafe.check), "unknown");
	assert.deepEqual(unsafe.calls, []);
});

test("a measured size is over at the threshold or when the generation reserve is unsafe", () => {
	assert.equal(contextPressureVerdict(usageView(156_000, 200_000), 0.78, reserve(true).check), "over");
	assert.equal(contextPressureVerdict(usageView(100_000, 200_000), 0.78, reserve(false).check), "over");
	const safe = reserve(true);
	assert.equal(contextPressureVerdict(usageView(100_000, 200_000), 0.78, safe.check), "under");
	assert.deepEqual(safe.calls, [100_000]);
});

test("a worker turn with an unmeasured size claims neither a size nor a safe reserve (#168)", () => {
	const safe = reserve(true);
	assert.deepEqual(workerTurnSizeFields(usageView(null, 200_000), safe.check), {});
	assert.deepEqual(workerTurnSizeFields(null, safe.check), {});
	assert.deepEqual(safe.calls, []);
});

test("a worker turn with a measured size reports it with the reserve verdict", () => {
	assert.deepEqual(workerTurnSizeFields(usageView(190_000, 200_000), reserve(false).check), {
		generationSafe: false,
		usage: { tokens: 190_000, contextWindow: 200_000, fraction: 0.95 },
	});
});
