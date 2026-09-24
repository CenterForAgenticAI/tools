import type { WindowSample } from "./window-history.js";
import { utilizationFromRemainingFraction } from "./window-history.js";

export type RateStatus = "available" | "unavailable";

export interface RateResult {
	readonly status: RateStatus;
	readonly rate?: number;
	readonly reason?: string;
}

const MIN_SAMPLES_REQUIRED = 3;
const MAX_GAP_MINUTES = 30;
const MAX_GAP_MS = MAX_GAP_MINUTES * 60 * 1000;
const MS_PER_HOUR = 3600 * 1000;

/**
 * Compute burn rate for one window from retained samples.
 * 
 * Rate formula: 100 × (latest utilization - earliest utilization) / elapsed hours
 * Reported as PERCENTAGE POINTS consumed per hour.
 * 
 * REQ-RATE-FORMULA: requires at least three consecutive samples with every adjacent
 * gap at most 30 minutes, all sharing one unchanged reset epoch. Any of the following
 * starts a NEW series and reports unavailable:
 * - fewer than three samples
 * - any adjacent gap over 30 minutes
 * - a decreased utilization value (backward move)
 * - a backward-moving or corrected reset epoch
 * 
 * REQ-WINDOW-UNIT: converts stored remainingFraction to utilization using the SAME
 * deterministic conversion as window-history.ts (1 - remainingFraction).
 * 
 * REQ-RESET-DETECTION: no rate may span an epoch boundary; a changed epoch immediately
 * yields unavailable.
 */
export function computeWindowRate(
	samples: readonly WindowSample[],
	windowId: string,
): RateResult {
	// Filter to the requested window and usable samples only
	// REQ-RESET-DETECTION: samples must have resetEpoch for rate computation
	const windowSamples = samples.filter(
		s => s.windowId === windowId && s.usable === true && s.resetEpoch !== undefined && s.remainingFraction !== undefined
	);

	if (windowSamples.length < MIN_SAMPLES_REQUIRED) {
		return {
			status: "unavailable",
			reason: `fewer than ${MIN_SAMPLES_REQUIRED} usable samples`,
		};
	}

	// Sort by recordedAtMs ascending
	const sorted = [...windowSamples].sort((a, b) => a.recordedAtMs - b.recordedAtMs);

	// Find the longest contiguous series that satisfies all rate conditions:
	// - all samples in the same reset epoch
	// - every adjacent gap ≤ 30 minutes
	// - monotonically non-decreasing utilization
	
	// Start searching from the MOST RECENT samples backward (we want the most current rate)
	for (let endIdx = sorted.length - 1; endIdx >= MIN_SAMPLES_REQUIRED - 1; endIdx -= 1) {
		// Try to build a series ending at endIdx
		const seriesEnd = sorted[endIdx];
		if (!seriesEnd) continue; // TypeScript guard
		
		const seriesEndEpoch = seriesEnd.resetEpoch;
		if (seriesEndEpoch === undefined) {
			// Cannot build a series without a reset epoch
			continue;
		}

		const series: WindowSample[] = [seriesEnd];
		
		// Walk backward from endIdx to find the longest valid prefix
		for (let i = endIdx - 1; i >= 0; i -= 1) {
			const candidate = sorted[i]; // EARLIER in time
			if (!candidate) break; // TypeScript guard
			
			const nextSample = series[0]; // The most recent sample we've added
			if (!nextSample) break; // TypeScript guard
			
			// Check reset epoch unchanged
			if (candidate.resetEpoch !== seriesEndEpoch) {
				break;
			}
			
			// Check gap constraint: gap between candidate and the NEXT sample (which is series[0] on first iteration)
			// We're building backward, so we prepend to series
			// series[0] will be the sample immediately AFTER candidate in chronological order
			const gap = nextSample.recordedAtMs - candidate.recordedAtMs;
			if (gap > MAX_GAP_MS) {
				break;
			}
			
			// Check monotonic non-decreasing utilization
			const candidateUtil = utilizationFromRemainingFraction(candidate.remainingFraction!);
			const nextUtil = utilizationFromRemainingFraction(nextSample.remainingFraction!);
			
			if (candidateUtil === undefined || nextUtil === undefined) {
				break;
			}
			
			// Utilization must be non-decreasing as we move forward in time
			// candidate is EARLIER than nextSample
			// Therefore candidateUtil must be ≤ nextUtil
			if (candidateUtil > nextUtil) {
				// Utilization decreased moving forward in time - reset boundary
				break;
			}
			
			// Prepend to series (we're building backward)
			series.unshift(candidate);
		}
		
		// Series is now in chronological order (oldest first) because we prepended
		
		if (series.length >= MIN_SAMPLES_REQUIRED) {
			// We have a valid series - compute rate
			const earliest = series[0];
			const latest = series[series.length - 1];
			
			if (!earliest || !latest) {
				// Should not happen, but TypeScript guard
				continue;
			}
			
			const earliestUtil = utilizationFromRemainingFraction(earliest.remainingFraction!);
			const latestUtil = utilizationFromRemainingFraction(latest.remainingFraction!);
			
			if (earliestUtil === undefined || latestUtil === undefined) {
				// Should not happen given prior checks, but be defensive
				continue;
			}
			
			const elapsedMs = latest.recordedAtMs - earliest.recordedAtMs;
			
			if (elapsedMs <= 0) {
				// All samples at the same timestamp - cannot compute rate
				return {
					status: "unavailable",
					reason: "zero elapsed time",
				};
			}
			
			const elapsedHours = elapsedMs / MS_PER_HOUR;
			const utilizationDelta = latestUtil - earliestUtil;
			const rate = 100 * utilizationDelta / elapsedHours;
			
			return {
				status: "available",
				rate,
			};
		}
	}

	// No valid series found
	return {
		status: "unavailable",
		reason: "no valid series found (epoch boundary, gap >30min, or utilization decreased)",
	};
}
