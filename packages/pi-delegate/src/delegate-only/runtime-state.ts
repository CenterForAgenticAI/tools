import type { DelegateOnlyConfig } from "./config.js";

export type DelegateOnlySource = "flag" | "command" | "off";

export interface DelegateOnlyMode {
	active: boolean;
	source: DelegateOnlySource;
	config: DelegateOnlyConfig;
}

export interface DelegateOnlyRuntime {
	getMode(): DelegateOnlyMode;
	setActive(active: boolean, source: DelegateOnlySource): void;
	subscribe(cb: (mode: DelegateOnlyMode) => void): () => void;
}

function copyConfig(config: DelegateOnlyConfig): DelegateOnlyConfig {
	return { ...config, allowlist: [...config.allowlist] };
}

function copyMode(mode: DelegateOnlyMode): DelegateOnlyMode {
	return { ...mode, config: copyConfig(mode.config) };
}

let activeRuntime: DelegateOnlyRuntime | undefined;

export function createDelegateOnlyRuntime(
	config: DelegateOnlyConfig,
	initialActive = false,
	initialSource: DelegateOnlySource = "off",
): DelegateOnlyRuntime {
	let mode: DelegateOnlyMode = {
		active: initialActive,
		source: initialSource,
		config: copyConfig(config),
	};
	const subscribers = new Set<(mode: DelegateOnlyMode) => void>();
	return {
		getMode(): DelegateOnlyMode {
			return copyMode(mode);
		},
		setActive(active: boolean, source: DelegateOnlySource): void {
			mode = { ...mode, active, source };
			const snapshot = copyMode(mode);
			for (const subscriber of subscribers) subscriber(copyMode(snapshot));
		},
		subscribe(cb: (mode: DelegateOnlyMode) => void): () => void {
			subscribers.add(cb);
			return () => subscribers.delete(cb);
		},
	};
}

export function getActiveDelegateOnlyMode(): DelegateOnlyMode | undefined {
	const mode = activeRuntime?.getMode();
	return mode?.active ? mode : undefined;
}

export function registerActiveDelegateOnlyRuntime(rt: DelegateOnlyRuntime | undefined): void {
	activeRuntime = rt;
}
