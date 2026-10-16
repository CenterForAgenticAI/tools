/** One safe path component; `default` is reserved for Pi's own agent directory. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DEFAULT_PROFILE = "default";

export function isProfileName(name: string): boolean {
	return name !== DEFAULT_PROFILE && NAME.test(name);
}

/** A name that may be selected: any profile name, or `default`. */
export function isSelectableName(name: string): boolean {
	return name === DEFAULT_PROFILE || NAME.test(name);
}
