/** Optional operator recognition only. Never a routing or account-matching key. */
export const ANTHROPIC_ACCOUNT_EMAIL = "piMultiAccountAnthropicEmail";

/** Read only an own data field: untrusted metadata must not invoke accessors. */
export function identityDataField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}

/** A bounded ASCII email, never trimmed or truncated into a different identity. */
export function normalizeAnthropicEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 254) return undefined;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]+$/.test(value)) return undefined;
  const domain = value.slice(value.indexOf("@") + 1);
  if (!domain.includes(".") || !domain.split(".").every((part) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))) return undefined;
  return value;
}

/** Metadata is accepted only from the one namespaced credential field. */
export function readAnthropicAccountEmail(credential: unknown): string | undefined {
  return normalizeAnthropicEmail(identityDataField(credential, ANTHROPIC_ACCOUNT_EMAIL));
}
