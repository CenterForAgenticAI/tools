/** Built-ins kept in the foreground delegate-only surface. [REQ-11/12] */
export const FOREGROUND_BUILTINS_KEPT: readonly string[] = ["read"];

/** Non-builtin tools allowed by default in delegate-only mode. [REQ-14] */
export const DEFAULT_DELEGATE_ONLY_ALLOWLIST: readonly string[] = [
	// These session-state tools are owned by pi-workstream or by pi-context-aware
	// (0.8.x registers session_tasks, session_focus and context_compact). Scope
	// them so a same-named registration cannot enter the foreground surface.
	"ext:@caair/pi-workstream:workstream_tasks",
	"ext:@caair/pi-workstream:workstream_focus",
	"ext:@caair/pi-context-aware:session_tasks",
	"ext:@caair/pi-context-aware:session_focus",
	"ext:@caair/pi-context-aware:compact_session",
	"ext:@caair/pi-context-aware:context_compact",
	"ext:@centerforagenticai/pi-context-aware:session_tasks",
	"ext:@centerforagenticai/pi-context-aware:session_focus",
	"ext:@centerforagenticai/pi-context-aware:compact_session",
	"ext:@centerforagenticai/pi-context-aware:context_compact",
	"ask",
	// pi-context-aware owns load_skill. pi-caair-dev-tools registers a fallback
	// copy only when no other extension provides one.
	"ext:@caair/pi-context-aware:load_skill",
	"ext:@centerforagenticai/pi-context-aware:load_skill",
	"ext:@caair/pi-caair-dev-tools:load_skill",
	"delegate_control",
	"delegate_escalation",
];

/** Minimum foreground tool floor that configuration cannot remove. [REQ-15] */
export const IRREDUCIBLE_FOREGROUND_TOOLS: readonly string[] = [
	"read",
	"delegate",
	"ask",
	"delegate_control",
	"compact_session",
];

/** Foreground tools banned by rule even when named by an allowlist. [REQ-3] */
export const BANNED_BY_RULE_FOREGROUND_TOOLS: readonly string[] = ["find_tool"];
