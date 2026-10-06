const MAX_DIAGNOSTIC_LENGTH = 512;
const REDACTED = "[REDACTED]";
const SENSITIVE_NAME_FRAGMENT = /(?:authorization|authentication|auth|token|credential|secret|cookie|apikey)/;
const PRIVATE_REASONING_KEY = /^(?:thinking|reasoning)/;
// Closed response observations: unknown names (including identifiers) never cross
// the callback or retained-diagnostic boundary, even when their value looks safe.
const COUNT_HEADERS = new Set([
  "x-ratelimit-remaining", "x-ratelimit-remaining-requests", "x-ratelimit-requests-remaining",
  "x-ratelimit-remaining-tokens", "x-ratelimit-tokens-remaining",
  "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-remaining",
  "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens",
  "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-tokens-limit",
  "retry-after-ms",
]);
const DURATION_RESET_HEADERS = new Set(["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]);
const ABSOLUTE_RESET_HEADERS = new Set([
  "x-ratelimit-reset", "anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset",
  "x-codex-primary-reset-at", "x-codex-secondary-reset-at",
]);
const SECONDS_HEADERS = new Set([
  "x-codex-primary-reset-after-seconds", "x-codex-secondary-reset-after-seconds",
]);
const PERCENT_HEADERS = new Set(["x-codex-primary-used-percent", "x-codex-secondary-used-percent"]);
const UTILIZATION_HEADERS = new Set([
  "anthropic-ratelimit-unified-5h-utilization", "anthropic-ratelimit-unified-7d-utilization",
  "anthropic-ratelimit-unified-7d-sonnet-utilization", "anthropic-ratelimit-unified-7d-opus-utilization",
]);
const STATUS_HEADERS = new Set(["anthropic-ratelimit-unified-status"]);
const RESPONSE_HEADER_NAMES = new Set([
  ...COUNT_HEADERS, ...DURATION_RESET_HEADERS, ...ABSOLUTE_RESET_HEADERS,
  ...SECONDS_HEADERS, ...PERCENT_HEADERS, ...UTILIZATION_HEADERS, ...STATUS_HEADERS, "retry-after",
]);
export const HEADER_DIAGNOSTIC_MESSAGE = "Provider response headers observed.";
export function isHeaderDiagnostic(category: unknown, message: unknown): boolean {
  return category === "provider.response" || message === HEADER_DIAGNOSTIC_MESSAGE;
}

export type DiagnosticLevel = "info" | "warning" | "error";

export interface DiagnosticEvent {
  readonly timestampMs: number;
  readonly level: DiagnosticLevel;
  readonly category: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** Credential-free persistence seam; implementations must fail soft. */
export interface DiagnosticPersistence {
  readRecent(limit: number): readonly DiagnosticEvent[];
  append(event: DiagnosticEvent): boolean;
}

function bound(value: string): string {
  return value.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "[UNAVAILABLE]";
  }
}

function redactDiagnosticText(value: unknown): string {
  return safeString(value)
    .replace(
      /\b(?:proxy[-_\s]*)?authorization\b["']?\s*[:=]\s*(?:["'][^"']*["']|(?:bearer|basic)\s+[^\s,;}&]+|[^\s,;}&]+)/gi,
      REDACTED,
    )
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, REDACTED)
    .replace(
      /\b(?:(?:x[-_\s]+)?api[-_\s]*key|access[-_\s]*token|refresh[-_\s]*token|id[-_\s]*token)\b["']?\s*[:=]\s*(?:["'][^"']*["']|[^\s,;}&]+)/gi,
      REDACTED,
    )
    .replace(/\b(?:sk|rk|pk)-(?:ant-)?[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(?:(?:test|synthetic)[-_]?)?(?:sk|token|canary)(?:[-_:][A-Za-z0-9._-]+)+\b/gi, REDACTED)
    .replace(/<(?:thinking|reasoning)>[\s\S]*?<\/(?:thinking|reasoning)>/gi, REDACTED)
    .replace(
      /\b(?:thinking|reasoning)(?:[-_\s]*(?:content|text|detail|data|signature))?\b["']?\s*[:=]\s*(?:["'][^"']*["']|[^\n,;}&]+)/gi,
      REDACTED,
    )
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, REDACTED);
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveName(name: string): boolean {
  const normalized = normalizedName(name);
  return SENSITIVE_NAME_FRAGMENT.test(normalized) || PRIVATE_REASONING_KEY.test(normalized);
}

function validTokenCount(value: string): boolean {
  if (value.length > 32 || !/^\d+$/.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

function validDuration(value: string): boolean {
  if (value.length > 64) return false;
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (matches.length === 0 || matches.map((match) => match[0]).join("") !== value) {
    return false;
  }
  let milliseconds = 0;
  for (const match of matches) {
    let multiplier = 1;
    switch (match[2]) {
      case "h": multiplier = 3_600_000; break;
      case "m": multiplier = 60_000; break;
      case "s": multiplier = 1_000; break;
    }
    milliseconds += Number(match[1]) * multiplier;
    if (!Number.isSafeInteger(Math.ceil(milliseconds)) || milliseconds < 0) return false;
  }
  return true;
}

function validAbsoluteReset(value: string): boolean {
  if (value.length > 128) return false;

  const epoch = /^(?<seconds>[1-9]\d{9})(?:\.(?<fraction>\d{1,3}))?$/.exec(value);
  if (epoch?.groups) {
    const epochMs = Number(epoch.groups["seconds"]) * 1_000
      + Number((epoch.groups["fraction"] ?? "").padEnd(3, "0"));
    if (!Number.isSafeInteger(epochMs)) return false;
    const fraction = epochMs % 1_000;
    const canonical = `${Math.floor(epochMs / 1_000)}${
      fraction === 0 ? "" : `.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`
    }`;
    return canonical === value;
  }

  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.exec(value);
  if (iso) {
    const epochMs = Date.parse(value);
    if (!Number.isFinite(epochMs) || epochMs < 0) return false;
    const canonical = new Date(epochMs).toISOString();
    return canonical === (value.includes(".") ? value : value.replace(/Z$/, ".000Z"));
  }

  const rfc1123 = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/.exec(value);
  if (!rfc1123) return false;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) && epochMs >= 0 && new Date(epochMs).toUTCString() === value;
}

function validatedResponseHeaderValue(name: string, value: unknown): string | undefined {
  const normalized = name.toLowerCase();
  if (!RESPONSE_HEADER_NAMES.has(normalized) || typeof value !== "string" || value !== value.trim()) return undefined;
  if (COUNT_HEADERS.has(normalized)) return validTokenCount(value) ? value : undefined;
  if (DURATION_RESET_HEADERS.has(normalized)) {
    return validDuration(value) || validAbsoluteReset(value) ? value : undefined;
  }
  if (ABSOLUTE_RESET_HEADERS.has(normalized)) return validAbsoluteReset(value) ? value : undefined;
  if (STATUS_HEADERS.has(normalized)) {
    return ["allowed", "allowed_warning", "rejected"].includes(value) ? value : undefined;
  }
  if (normalized === "retry-after" && validAbsoluteReset(value)) return value;
  if (value.length > 32 || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const number = Number(value);
  const maximum = PERCENT_HEADERS.has(normalized) ? 100 : UTILIZATION_HEADERS.has(normalized) ? 1 : Number.MAX_SAFE_INTEGER / 1000;
  return Number.isFinite(number) && number >= 0 && number <= maximum ? value : undefined;
}

/** Sanitizes and bounds one upstream-derived diagnostic value before storage. */
export function sanitizeDiagnosticText(value: unknown): string {
  return bound(redactDiagnosticText(value));
}

/** Compatibility scalar API; unsupported names and malformed observations are redacted. */
export function sanitizeHeaderValue(name: string, value: unknown): string {
  return validatedResponseHeaderValue(name, value) ?? REDACTED;
}

/** Copy only named, validated quota/retry facts. Never retain caller keys or prose. */
export function projectResponseHeaders(headers: unknown): Record<string, string> {
  const projected: Record<string, string> = {};
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return projected;
  for (const [name, value] of Object.entries(headers)) {
    const validated = validatedResponseHeaderValue(name, value);
    if (validated !== undefined) projected[name.toLowerCase()] = validated;
  }
  return projected;
}

function sanitizeFields(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  // Preserve JSON's native absence semantics: `undefined` is omitted from
  // objects and rendered as null in arrays by JSON.stringify. Returning it
  // verbatim (rather than falling through to sanitizeDiagnosticText, which
  // would coerce it to the literal string "undefined") keeps optional status
  // fields like coolingUntilMs / usage absent instead of a bogus string.
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string" || typeof value === "bigint" || typeof value === "symbol") {
    return sanitizeDiagnosticText(value);
  }
  if (value instanceof Error) {
    try {
      return sanitizeDiagnosticText(value.message);
    } catch {
      return "[UNAVAILABLE]";
    }
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => sanitizeFields(entry, depth + 1));
  if (typeof value !== "object") return sanitizeDiagnosticText(value);

  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    const sanitized = isSensitiveName(key)
      ? REDACTED
      : sanitizeFields(entry, depth + 1);
    // Omit undefined-valued keys entirely, matching JSON.stringify's native
    // object semantics (an absent field, not a key mapped to "undefined").
    if (sanitized === undefined) continue;
    projected[sanitizeDiagnosticText(key)] = sanitized;
  }
  return projected;
}

/** Produces a detached, sanitized JSON value; the input object is never retained. */
export function sanitizeForJson(value: unknown): unknown {
  return sanitizeFields(value);
}

export function sanitizedJson(value: unknown): string {
  return JSON.stringify(sanitizeForJson(value));
}

/**
 * Reserve the budget for newest failures/routing facts before routine observations.
 * Both classes share one hard bound; a priority flood evicts older priority facts.
 * Return append order, not priority order or wall-clock order. Oversized records
 * are skipped so one record cannot prevent smaller, useful facts from fitting.
 */
export function retainDiagnosticEvents(
  events: readonly DiagnosticEvent[],
  budget: number,
  sizeOf: (event: DiagnosticEvent) => number = () => 1,
): readonly DiagnosticEvent[] {
  const retained = new Set<number>();
  const sizes = events.map(sizeOf);
  let used = 0;
  for (const priority of [true, false]) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      const isPriority = event.level !== "info" || event.category === "routing" ||
        event.category.startsWith("routing.") || event.category === "logical.provider";
      if (isPriority !== priority) continue;
      const size = sizes[index]!;
      if (size > budget - used) continue;
      retained.add(index);
      used += size;
    }
  }
  return events.filter((_event, index) => retained.has(index));
}

export class DiagnosticLog {
  readonly #events: DiagnosticEvent[] = [];
  readonly #maxEvents: number;
  readonly #now: () => number;
  readonly #persistence: DiagnosticPersistence | undefined;

  constructor(options: {
    maxEvents?: number;
    now?: () => number;
    persistence?: DiagnosticPersistence;
  } = {}) {
    this.#maxEvents = options.maxEvents ?? 100;
    this.#now = options.now ?? Date.now;
    this.#persistence = options.persistence;
    if (!Number.isSafeInteger(this.#maxEvents) || this.#maxEvents < 1 || this.#maxEvents > 1_000) {
      throw new RangeError("maxEvents must be an integer from 1 through 1000.");
    }
    try {
      const persisted = this.#persistence?.readRecent(this.#maxEvents) ?? [];
      for (const event of persisted.slice(-this.#maxEvents)) {
        this.#events.push(Object.freeze({
          ...event,
          message: isHeaderDiagnostic(event.category, event.message) ? HEADER_DIAGNOSTIC_MESSAGE : event.message,
          fields: Object.freeze(isHeaderDiagnostic(event.category, event.message)
            ? projectResponseHeaders(event.fields) : { ...event.fields }),
        }));
      }
    } catch {
      // Diagnostics persistence is best-effort and must never block startup.
    }
  }

  record(
    level: DiagnosticLevel,
    category: string,
    message: unknown,
    fields: Readonly<Record<string, unknown>> = {},
  ): DiagnosticEvent {
    const safeFields: Record<string, string> = {};
    const projectedFields = isHeaderDiagnostic(category, message) ? projectResponseHeaders(fields) : fields;
    for (const [key, value] of Object.entries(projectedFields)) {
      safeFields[sanitizeDiagnosticText(key)] = sanitizeDiagnosticText(value);
    }
    const event = Object.freeze({
      timestampMs: this.#now(),
      level,
      category: sanitizeDiagnosticText(category),
      message: isHeaderDiagnostic(category, message) ? HEADER_DIAGNOSTIC_MESSAGE : sanitizeDiagnosticText(message),
      fields: Object.freeze(safeFields),
    });
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      const retained = retainDiagnosticEvents(this.#events, this.#maxEvents);
      this.#events.splice(0, this.#events.length, ...retained);
    }
    try {
      this.#persistence?.append(event);
    } catch {
      // Recording remains available in memory even when persistence fails.
    }
    return event;
  }

  recordError(category: string, _error: unknown): DiagnosticEvent {
    // Generic errors can originate at provider, OAuth, model-selection, fetch,
    // request, or extension boundaries. Their messages may therefore contain
    // endpoint bodies, credential material, request payloads, or conversation
    // content. Persist the bounded failure fact and category only; callers that
    // possess safe structured facts record those separately.
    return this.record(
      "error",
      category,
      "An error occurred; raw details were omitted.",
    );
  }

  recordHeaders(category: string, headers: Readonly<Record<string, unknown>>): DiagnosticEvent {
    return this.record("info", category, HEADER_DIAGNOSTIC_MESSAGE, projectResponseHeaders(headers));
  }

  recent(limit = 20): readonly DiagnosticEvent[] {
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, 100)) : 20;
    return retainDiagnosticEvents(this.#events, safeLimit)
      .map((event) => ({ ...event, fields: { ...event.fields } }));
  }

  formatRecent(limit = 20): string {
    return this.recent(limit)
      .map((event) => `${event.level} ${event.category}: ${event.message} ${sanitizedJson(event.fields)}`)
      .join("\n");
  }

  serialize(): string {
    return sanitizedJson(this.#events);
  }

  sanitizeOutput(value: unknown): string {
    // Aggregate command/status output may contain many independently bounded
    // values. Redact it again at the final sink without truncating the aggregate.
    return redactDiagnosticText(value);
  }

  clear(): void {
    this.#events.length = 0;
  }
}

export { MAX_DIAGNOSTIC_LENGTH, REDACTED };
