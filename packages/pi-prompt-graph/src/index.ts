import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EmbeddedRunner } from "./runners/embedded.js";
import { AgentAdapter, GitWorktreeAllocator } from "./adapters/agent.js";
import { ChildProcessDispatcher } from "./runners/child-dispatcher.js";
import { FileAgentResolver, agentSearchPath } from "./runners/agent-definitions.js";
import { TemplateAdapter } from "./adapters/template.js";
import { LiveTemplateSession, probeCapabilities } from "./adapters/live-template.js";
import { SessionInterruptions, suspendedRunIn } from "./runners/lifecycle.js";
import { SessionGuard, decideTransition } from "./runners/guard-session.js";
import { explainRun, inspectRun, loadRunGraph, runStatus } from "./runners/observability.js";
import { readJournal } from "./journal.js";
import { compile } from "./pure/compiler.js";
import { parseShorthand } from "./pure/parser.js";
import { loadGraphSource } from "./loader.js";
import type { CompiledNode, ExecutableGraph, JsonObject, RunOptions } from "./model.js";

export type * from "./model.js";
export type * from "./pure/parser.js";
export type * from "./pure/compiler.js";
export type * from "./pure/validator.js";
export type * from "./pure/routing.js";
export type * from "./pure/human.js";
export type * from "./pure/artifact.js";
export type * from "./pure/status.js";
export type * from "./pure/lifecycle.js";
export type * from "./runners/lifecycle.js";
export type * from "./runners/guard-session.js";
export type * from "./loader.js";
export type * from "./journal.js";
export type * from "./adapters/index.js";
export type * from "./runners/session.js";
export type * from "./runners/embedded.js";
export type * from "./runners/observability.js";
export type * from "./runners/durable.js";

async function graphPath(name: string, cwd: string): Promise<{ path: string; scope: "project" | "user" } | undefined> {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) return undefined;
	const project = join(cwd, ".pi", "graphs", `${name}.md`);
	try { await access(project); return { path: project, scope: "project" }; } catch { /* try user scope */ }
	const user = join(homedir(), ".pi", "agent", "graphs", `${name}.md`);
	try { await access(user); return { path: user, scope: "user" }; } catch { return undefined; }
}

function mermaid(graph: ExecutableGraph): string {
	const lines = ["flowchart LR"];
	for (const node of Object.values(graph.nodes)) {
		const targets = [...(node.transitions.next ?? []), ...Object.values(node.transitions.on), ...(node.transitions.default ? [node.transitions.default] : []), ...node.transitions.when.map((clause) => clause.to), ...(node.limit ? [node.limit.onLimit] : [])];
		for (const target of targets) lines.push(`  ${node.id} -->|${node.transitions.kind === "conditional" ? "route" : "next"}| ${target}`);
	}
	return lines.join("\n");
}

function diagnosticText(diagnostics: Array<{ severity: string; code: string; message: string; nodeId?: string }>): string {
	return diagnostics.map((item) => `${item.severity} ${item.code}${item.nodeId ? ` [${item.nodeId}]` : ""}: ${item.message}`).join("\n");
}

function parseInput(value: string | undefined): JsonObject {
	if (!value) return {};
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Run input must be a JSON object.");
	return parsed as JsonObject;
}

const USAGE = "Usage: /graph check|show|expand|run <name> | resume <runId> [answer] | explain|inspect|status <runId> | goto <runId> <node> | stop <runId>";

function commandError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function runOptions(cwd: string, graph: ExecutableGraph): RunOptions {
	return {
		mode: graph.mode,
		interactive: true,
		allowNonInteractive: false,
		allowNonInteractiveMutating: false,
		runsRoot: join(cwd, ".pi", "runs"),
	};
}

/**
 * The adapters a graph needs, for `run` and for `resume` alike.
 *
 * Shared on purpose. These were assembled inline in `run` and not at all in
 * `resume`, so a suspended run of any graph using templates or delegated agents
 * came back with nothing installed and failed on its first such node (#37).
 * Two call sites that must agree are two call sites that will drift, and this
 * one drifted the moment `run` gained an adapter.
 *
 * `runDir` must be the run's own directory. On a resume that is the **original**
 * run's directory, not a fresh one: a node's contract result is read from and
 * written to `<runDir>/nodes/<node>/`, so a new directory would silently lose
 * the evidence a resume exists to reuse (D-063).
 */
function adaptersFor(graph: ExecutableGraph, pi: ExtensionAPI, cwd: string, runDir: string): { template?: TemplateAdapter; agent?: AgentAdapter } {
	const nodes = Object.values(graph.nodes);
	const adapters: { template?: TemplateAdapter; agent?: AgentAdapter } = {};
	if (nodes.some((node) => node.kind === "template")) {
		adapters.template = new TemplateAdapter({ session: new LiveTemplateSession({ events: pi.events, turns: pi }) });
	}
	if (nodes.some((node) => node.kind === "agent")) {
		adapters.agent = new AgentAdapter({
			runDir,
			dispatcher: new ChildProcessDispatcher({
				agents: new FileAgentResolver(cwd),
				agentSearchPath: agentSearchPath(cwd),
			}),
			// Each node declaring `worktree: true` gets its own checkout under the
			// run that owns it. Not `.worktrees/`, which is where people put branch
			// work and where a leftover directory reads as unfinished change.
			worktrees: new GitWorktreeAllocator(cwd, join(runDir, "worktrees")),
			defaultCwd: cwd,
		});
	}
	return adapters;
}


/**
 * The compiled nodes the guard says are current.
 *
 * The guard holds node ids; `decideTransition` needs the compiled nodes. Ids
 * the graph does not contain are dropped rather than faked, which keeps a stale
 * id from becoming a transition source.
 */
function currentNodesOf(guard: SessionGuard, graph: ExecutableGraph): CompiledNode[] {
	return guard.currentNodeIds().map((id) => graph.nodes[id]).filter((node): node is CompiledNode => node !== undefined);
}

/** Pi extension entry point for graph authoring and Stage-2 run commands. */
export default function promptGraphExtension(pi: ExtensionAPI): void {
	// Watches the whole session, not one run: a person types, or the session
	// ends, and whichever run is active reads it at its next node boundary.
	const interruptions = new SessionInterruptions(pi);

	// Mode A's guard: the graph constraining the agent it shares a session with.
	// It holds which nodes are current and answers one question — may this tool
	// run right now.
	const guard = new SessionGuard();
	// The graph currently running, for `graph_transition` to check a request
	// against. Undefined between runs, which is when a transition request has no
	// "from" and is refused rather than guessed.
	let activeGraph: ExecutableGraph | undefined;

	// Pi documents this hook as fail-safe: an error in a handler blocks the tool.
	// So the guard must never throw on a tool it has no opinion about, and
	// `check` returns undefined for exactly that case.
	pi.on?.("tool_call", (event: { toolName?: string }) => {
		const tool = typeof event?.toolName === "string" ? event.toolName : undefined;
		return tool ? guard.check(tool) : undefined;
	});

	// The agent may request a transition when the graph delegates that decision.
	// An illegal target is refused and never rewritten to the nearest legal one
	// (D-057); the refusal names the legal targets so the agent can choose again.
	pi.registerTool?.({
		name: "graph_transition",
		label: "Graph transition",
		description: "Request that the running graph move to a named node. Only transitions the graph's own edges permit are accepted; an illegal target is refused, never corrected.",
		parameters: Type.Object({ to: Type.String({ description: "The node id to move to." }) }),
		execute(_toolCallId: string, params: { to: string }): Promise<{ content: Array<{ type: "text"; text: string }>; details: { to?: string; refused?: boolean } }> {
			const say = (text: string, details: { to?: string; refused?: boolean } = {}): Promise<{ content: Array<{ type: "text"; text: string }>; details: { to?: string; refused?: boolean } }> =>
				Promise.resolve({ content: [{ type: "text" as const, text }], details });
			if (!activeGraph) return say("No graph is running, so there is no transition to make.", { refused: true });
			const outcome = decideTransition(activeGraph, currentNodesOf(guard, activeGraph), { to: params.to });
			if (outcome.ok) return say(`Transition to ${params.to} is legal and has been requested.`, { to: params.to });
			const legal = outcome.legal?.length ? ` Legal targets: ${outcome.legal.join(", ")}.` : "";
			return say(`${outcome.reason ?? "Refused."}${legal}`, { refused: true });
		},
	});

	// Told once, on the next session in this directory, that a run is waiting.
	// Opening a session to read a file is not consent to resume yesterday's loop
	// and spend money on it, so this notifies and stops there (D-022).
	pi.on?.("session_start", async (_event, ctx) => {
		try {
			const waiting = await suspendedRunIn(join(ctx.cwd, ".pi", "runs"));
			if (!waiting) return;
			const graphName = waiting.graphName ? ` of graph "${waiting.graphName}"` : "";
			ctx.ui.notify(`A suspended graph run${graphName} is waiting: ${waiting.runId}\nResume it with /graph resume ${waiting.runId}, or leave it.`, "warning");
		} catch {
			// A notice that cannot be produced must never stop a session starting.
		}
	});

	pi.registerCommand("graph", {
		description: "Check, show, expand, run, resume, explain, inspect, or report the status of a prompt graph",
		async handler(args, ctx) {
			const [action, name, ...rest] = args.trim().split(/\s+/);
			if (!action) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			// The operator's manual controls. Unlike the agent's `graph_transition`,
			// a `goto` is NOT checked against the compiled edges: overriding them is
			// the entire point of a manual move, and the journal record is what keeps
			// it attributable to a person rather than to the graph (D-057).
			if (action === "goto" || action === "stop") {
				if (!name || !/^[A-Za-z0-9-]+$/.test(name)) { ctx.ui.notify(`Usage: /graph ${action} <runId>${action === "goto" ? " <node>" : ""}`, "error"); return; }
				const target = rest[0];
				if (action === "goto" && !target) { ctx.ui.notify("Usage: /graph goto <runId> <node>", "error"); return; }
				try {
					// Only `runsRoot` is read: recording a move appends one journal
					// record and runs nothing, so the rest of RunOptions has no bearing.
					const moveOptions: RunOptions = { mode: "session", interactive: true, allowNonInteractive: false, allowNonInteractiveMutating: false, runsRoot: join(ctx.cwd, ".pi", "runs") };
					await new EmbeddedRunner().recordOperatorMove(name, moveOptions, { action, ...(target ? { to: target } : {}) });
					ctx.ui.notify(action === "goto" ? `Recorded an operator move to ${target} for run ${name}.` : `Recorded an operator stop for run ${name}.`, "info");
				} catch (error) { ctx.ui.notify(commandError(error), "error"); }
				return;
			}
			if (action === "explain" || action === "inspect" || action === "resume" || action === "status") {
				if (!name || !/^[A-Za-z0-9-]+$/.test(name)) { ctx.ui.notify(`Usage: /graph ${action} <runId>`, "error"); return; }
				try {
					const directory = join(ctx.cwd, ".pi", "runs", name);
					if (action === "status") {
						const line = await runStatus(directory);
						ctx.ui.notify(line.line, "info");
					} else if (action === "resume") {
						const graph = await loadRunGraph(directory);
						const records = await readJournal(directory);
						const started = records.find((record) => record.type === "run-started");
						if (!started || started.type !== "run-started") throw new Error("Journal has no run-started record.");
						// Everything after the runId is the operator's answer to a waiting
						// human node, delivered to that node and to nothing after it (D-021).
						const answer = rest.join(" ").trim();
						// The same adapters `run` installs, against the ORIGINAL run's
						// directory. Resuming used to install none at all, so a
						// suspended template or agent run failed on its first such node
						// — which is every graph worth resuming (#37).
						const resumeAdapters = adaptersFor(graph, pi, ctx.cwd, directory);
						const handle = await new EmbeddedRunner({
							adapters: resumeAdapters,
							...(resumeAdapters.template ? { templateCapabilities: await probeCapabilities(pi.events) } : {}),
							interruptions,
							currentNodes: guard,
						}).resume(name, graph, started.options, answer ? { answer } : {});
						if (handle.status === "waiting-human" && handle.waitingHuman) {
							ctx.ui.notify(`${handle.waitingHuman.question}\n${handle.waitingHuman.refusal ?? ""}\nAnswer with /graph resume ${handle.runId} <${handle.waitingHuman.accepts.join("|")}>`.replace(/\n+/g, "\n"), "warning");
							return;
						}
						ctx.ui.notify(JSON.stringify({ runId: handle.runId, status: handle.status, result: handle.result, failure: handle.failure }, null, 2), handle.status === "completed" ? "info" : "error");
					} else {
						const maxBytesIndex = rest.indexOf("--max-bytes");
						const limitIndex = rest.indexOf("--limit");
						const output = action === "explain" ? await explainRun(directory) : await inspectRun(directory, { ...(rest[0] === "--path" && rest[1] !== undefined ? { path: rest[1] } : {}), full: rest.includes("--full"), inventory: rest.includes("--inventory"), ...(limitIndex >= 0 ? { limit: Number(rest[limitIndex + 1]) } : {}), ...(maxBytesIndex >= 0 ? { maxBytes: Number(rest[maxBytesIndex + 1]) } : {}) });
						ctx.ui.notify(JSON.stringify(output, null, 2), "info");
					}
				} catch (error) { ctx.ui.notify(commandError(error), "error"); }
				return;
			}
			if (!name || !["check", "show", "expand", "run"].includes(action)) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			const located = await graphPath(name, ctx.cwd);
			if (!located) { ctx.ui.notify(`Graph ${name} was not found.`, "error"); return; }
			const loaded = await loadGraphSource(located.path);
			if (!loaded.source) { ctx.ui.notify(diagnosticText(loaded.diagnostics), "error"); return; }
			// Discovery stays outside the pure compiler. Every shipped compile path gets
			// one immutable snapshot; the runtime adapter resolves again when it starts a
			// worker, so a later filesystem change is still authoritative.
			const agents = await new FileAgentResolver(ctx.cwd).catalog();
			const origin = { scope: located.scope, path: located.path, sha256: loaded.source.sha256 };
			if (action === "expand" && typeof (loaded.source.document as { graph?: unknown }).graph === "string") {
				const parsed = parseShorthand((loaded.source.document as { graph: string }).graph);
				if (parsed.body) {
					const expanded = { ...(loaded.source.document as Record<string, unknown>), graph: parsed.body };
					const expandedResult = compile({ document: expanded, bodyBytes: loaded.source.bodyBytes, origin, agents });
					if (expandedResult.graph) ctx.ui.notify(JSON.stringify(expanded, null, 2), "info");
					else ctx.ui.notify(diagnosticText(expandedResult.diagnostics), "error");
				} else ctx.ui.notify(diagnosticText(parsed.diagnostics.map((item) => ({ ...item, severity: "error" }))), "error");
				return;
			}
			const result = compile({ document: loaded.source.document, bodyBytes: loaded.source.bodyBytes, origin, agents });
			if (action === "show") {
				if (result.graph) ctx.ui.notify(mermaid(result.graph), "info");
				else ctx.ui.notify(diagnosticText(result.diagnostics), "error");
				return;
			}
			if (!result.graph) {
				ctx.ui.notify(diagnosticText(result.diagnostics), "error");
				return;
			}
			if (action === "run") {
				try {
					const inputFlag = rest.indexOf("--input");
					// Everything after `--input` is the JSON, rejoined. Taking only the
					// next whitespace-delimited fragment made the flag unusable for any
					// object containing a space — which is nearly all real input. The
					// first real use of this package hit it on its first command (#30).
					const input = parseInput(inputFlag >= 0 ? rest.slice(inputFlag + 1).join(" ") : undefined);
					// Each adapter is installed only for a graph that actually has that
					// kind of node. A command-and-set graph pays nothing for PTM's
					// absence, and the capability probe — which emits a real event and
					// waits — never runs for a graph that would not use it.
					//
					// The agent adapter was missing here entirely until #33, so an
					// `agent` node failed mid-run with "No adapter is installed for
					// agent nodes" and two of the four worked examples could not be run
					// by this command at all. Every test that exercised one injected
					// its own adapter, which is the port split working as designed and
					// is exactly why nothing caught it.
					const nodes = Object.values(result.graph.nodes);
					const hasTemplate = nodes.some((node) => node.kind === "template");
					const options = runOptions(ctx.cwd, result.graph);
					// The run id is chosen here rather than by the runner, because the
					// agent adapter has to know the run directory before the run starts.
					const runId = randomUUID();

					const adapters = adaptersFor(result.graph, pi, ctx.cwd, join(options.runsRoot, runId));

					const runner = new EmbeddedRunner({
						adapters,
						...(hasTemplate ? { templateCapabilities: await probeCapabilities(pi.events) } : {}),
						// A command-and-set graph is interruptible too: a person typing
						// while one runs pauses it at the next node boundary exactly as
						// it does in Mode A. It publishes current nodes as well, so an
						// `agent` node's allowlist is enforced in either assembly.
						interruptions,
						currentNodes: guard,
					});
					activeGraph = result.graph;
					const handle = await runner.start({ graph: result.graph, graphName: name, input, options, runId });

					// A completed run cleans up its own checkouts; a run that did not
					// complete keeps them, because a worktree is what the worker
					// actually did and is worth reading precisely when something went
					// wrong. Release goes through git rather than deleting the
					// directory: a worktree is registered inside `.git`, and removing
					// the files alone leaves a dead entry behind in `git worktree list`.
					if (adapters.agent && handle.status === "completed") {
						await adapters.agent.releaseWorktrees(nodes.filter((node) => node.binding.kind === "agent" && node.binding.worktree).map((node) => node.id));
					}
					if (handle.status === "waiting-human" && handle.waitingHuman) {
						ctx.ui.notify(`${handle.waitingHuman.question}\nAnswer with /graph resume ${handle.runId} <${handle.waitingHuman.accepts.join("|")}>`, "warning");
						return;
					}
					ctx.ui.notify(JSON.stringify({ runId: handle.runId, status: handle.status, result: handle.result, failure: handle.failure, status_line: handle.statusLine?.line }, null, 2), handle.status === "completed" ? "info" : "error");
				} catch (error) { ctx.ui.notify(commandError(error), "error"); }
				// However the run ended, nothing is current afterwards and no graph is
				// active. Leaving either set would let the guard refuse the operator's
				// own tool calls once the run is over.
				finally { guard.leave(); activeGraph = undefined; }
				return;
			}
			const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
			ctx.ui.notify(result.diagnostics.length ? `${diagnosticText(result.diagnostics)}${errors.length === 0 ? "\nGraph is valid." : ""}` : "Graph is valid.", errors.length === 0 ? "info" : "error");
		},
	});
}
