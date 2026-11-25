/** Advertise string enums explicitly for providers that require a primitive type. */

import { oneOf, type Schema } from "@earendil-works/pi-schema";

export function stringEnum<const T extends readonly string[]>(values: T, options: { description?: string } = {}): Schema<T[number]> {
	return { type: "string", ...oneOf([...values], options) };
}
