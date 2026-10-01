const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const MAX_INHERITED_ENVIRONMENT_VARIABLES = 32;
export const MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH = 128;

/** Accept only portable, bounded environment variable names that can be safely passed to a verifier. */
export function isEnvironmentVariableName(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH && ENVIRONMENT_VARIABLE_NAME.test(value) && !/^(?:PATH|HOME|ENV|IFS|CDPATH|BASH_ENV|SHELLOPTS|XDG_.*|DBUS_.*|LD_.*|DYLD_.*|GIT_.*|SYSTEMD_.*)$/.test(value);
}

/** A declaration must be non-empty, bounded, unique, and made only of valid variable names. */
export function isEnvironmentVariableList(value: unknown): value is readonly string[] | undefined {
	if (value === undefined) return true;
	return Array.isArray(value) && value.length > 0 && value.length <= MAX_INHERITED_ENVIRONMENT_VARIABLES && value.every(isEnvironmentVariableName) && new Set(value).size === value.length;
}
