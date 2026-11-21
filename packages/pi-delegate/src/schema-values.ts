import { lit, oneOf, type Annotations, type Schema } from "@earendil-works/pi-schema";

/** Provider schemas retain the explicit primitive type alongside their literal. */
export function typedLiteral<const V extends string | number | boolean>(value: V, options?: Annotations<V>): Schema<V> {
	return { ...lit(value, options), type: typeof value };
}

/** Some provider tool schemas require a type even when enum already constrains it. */
export function stringEnum<const V extends readonly string[]>(values: V, options?: Annotations<V[number]>): Schema<V[number]> {
	return { ...oneOf(values, options), type: "string" };
}
