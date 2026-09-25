/** Built-ins kept in the foreground delegate-only surface. [REQ-11/12] */
export const FOREGROUND_BUILTINS_KEPT: readonly string[] = ["read"];

/** Non-builtin tools allowed by default in delegate-only mode. [REQ-14] */
export const DEFAULT_DELEGATE_ONLY_ALLOWLIST: readonly string[] = [
	// These session-state tools are owned by the context-aware package. Scope
	// them so a same-named registration cannot enter the foreground surface.
	"ext:@caair/pi-context-aware:session_tasks",
	"ext:@caair/pi-context-aware:session_focus",
	"ext:@caair/pi-context-aware:compact_session",
	"ext:@centerforagenticai/pi-context-aware:session_tasks",
	"ext:@centerforagenticai/pi-context-aware:session_focus",
	"ext:@centerforagenticai/pi-context-aware:compact_session",
	"ask",
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
