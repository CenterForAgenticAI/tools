/** A Pi session file as Pi 1.x writes it: a header, then one user prompt and one reply per prompt, a minute apart. */
export interface SessionSpec {
	readonly id: string;
	readonly cwd: string;
	readonly name?: string;
	readonly prompts: readonly string[];
	/** The header time, in ms. */
	readonly t0: number;
}

export function piSession(spec: SessionSpec): string {
	const lines: unknown[] = [{ type: "session", version: 3, id: spec.id, timestamp: new Date(spec.t0).toISOString(), cwd: spec.cwd }];
	let parent: string | null = null;
	let n = 0;
	const add = (entry: Record<string, unknown>, at: number): void => {
		const id = (++n).toString(16).padStart(8, "0");
		lines.push({ ...entry, id, parentId: parent, timestamp: new Date(at).toISOString() });
		parent = id;
	};
	add({ type: "model_change", provider: "anthropic", modelId: "m" }, spec.t0);
	spec.prompts.forEach((p, i) => {
		const at = spec.t0 + (i + 1) * 60_000;
		add({ type: "message", message: { role: "user", content: [{ type: "text", text: p }], timestamp: at } }, at);
		add({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply to " + p }], timestamp: at + 30_000 } }, at + 30_000);
	});
	if (spec.name !== undefined) add({ type: "session_info", name: spec.name }, spec.t0 + 1);
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
