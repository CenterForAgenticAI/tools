import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Extension-local outgoing boundary. Dispatch guards cover filesystem writers;
 * sink guards also cover captured async callbacks and boundary draft returns.
 * The host API and other extensions' contexts are never modified.
 */
export function guardErasureWrites(pi: ExtensionAPI, isRefused: () => boolean, start?: (ctx: ExtensionContext) => Promise<void>): ExtensionAPI {
	// Pi dispatches one event object through all startup registrations. Acquire
	// protection once, before even the first callback, without a second lifecycle slot.
	const startups = new WeakMap<object, Promise<void>>();
	const prepareStart = (data: object, ctx: ExtensionContext): Promise<void> => {
		let opening = startups.get(data);
		if (!opening) { opening = start!(ctx); startups.set(data, opening); }
		return opening;
	};
	type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
	const commands = new WeakMap<CommandHandler, CommandHandler>();
	const managers = new WeakMap<object, ExtensionContext["sessionManager"]>();
	const context = <T extends ExtensionContext>(ctx: T): T => new Proxy(ctx, {
		get(target, key) {
			if (key === "sessionManager") {
				const manager = target.sessionManager;
				let guarded = managers.get(manager);
				if (!guarded) {
					guarded = new Proxy(manager, {
						get(source, member) {
							const value: unknown = Reflect.get(source, member);
							if (typeof value !== "function") return value;
							// Public readonly projection plus historical read-only host methods.
							const read = /^(get|build|is|uses)/u.test(String(member));
							return (...args: unknown[]) => !read && isRefused() ? undefined : Reflect.apply(value, source, args);
						},
					});
					managers.set(manager, guarded);
				}
				return guarded;
			}
			const value: unknown = Reflect.get(target, key);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (isRefused() && ["compact", "executeTool", "newSession", "switchSession", "fork", "navigateTree"].includes(String(key))) return undefined;
				return Reflect.apply(value, target, args);
			};
		},
	});
	const writes = new Set(["appendEntry", "sendMessage", "sendCustomMessage", "sendUserMessage", "setSessionName", "setLabel", "setModel", "setThinkingLevel"]);
	return new Proxy(pi, {
		get(target, key) {
			if (key === "registerCommand") return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				let handler = commands.get(command.handler);
				if (!handler) {
					handler = async (args, ctx) => { if (!isRefused()) await command.handler(args, context(ctx)); };
					commands.set(command.handler, handler);
				}
				target.registerCommand(name, { ...command, handler });
			};
			if (key === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => target.registerTool({
				...tool,
				execute: (id, params, signal, onUpdate, ctx) => {
					if (isRefused()) throw new Error("Session activation refused; tool execution is blocked.");
					return tool.execute(id, params, signal, onUpdate, context(ctx));
				},
			});
			if (key === "on") return (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				const on = target.on as (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => () => void;
				return on.call(target, event, (data, ctx) => {
					const dispatch = () => {
						if (isRefused()) return event === "input" ? { action: "handled" } : undefined;
						const result = handler(data, context(ctx));
						const release = (value: unknown) => isRefused() ? undefined : value;
						return result instanceof Promise ? result.then(release) : release(result);
					};
					return event === "session_start" && start && typeof data === "object" && data !== null
						? prepareStart(data, ctx).then(dispatch) : dispatch();
				});
			};
			const value: unknown = Reflect.get(target, key);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (writes.has(String(key)) && isRefused()) return key === "setModel" ? Promise.resolve(false) : undefined;
				return Reflect.apply(value, target, args);
			};
		},
	});
}
