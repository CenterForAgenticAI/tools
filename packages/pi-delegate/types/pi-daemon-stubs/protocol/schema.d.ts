// VENDORED build-time type fallback for the OPTIONAL @caair/pi-daemon peer (#35 / #470).
// Copied verbatim from @caair/pi-daemon dist .d.ts. Used ONLY when the package is
// absent (tsconfig `paths` resolves the real node_modules types first, these second),
// so pi-delegate builds/type-checks without the package. Regenerate by re-copying
// @caair/pi-daemon/dist/{client,protocol}/*.d.ts when the daemon protocol changes.
// Do not hand-edit.
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export type JsonSchema = Readonly<Record<string, unknown>>;
export interface Schema<out T, out J extends JsonSchema = JsonSchema> {
    readonly jsonSchema: J;
    readonly is: (value: unknown) => value is T;
}
export type Infer<S extends Schema<unknown>> = S extends Schema<infer T> ? T : never;
type AnySchema = Schema<unknown>;
interface OptionalSchema<S extends AnySchema> {
    readonly optional: true;
    readonly schema: S;
}
type PropertySchema = AnySchema | OptionalSchema<AnySchema>;
type UnwrapProperty<P extends PropertySchema> = P extends OptionalSchema<infer S> ? S : P;
type OptionalKeys<P extends Record<string, PropertySchema>> = {
    [K in keyof P]: P[K] extends OptionalSchema<AnySchema> ? K : never;
}[keyof P];
type RequiredKeys<P extends Record<string, PropertySchema>> = Exclude<keyof P, OptionalKeys<P>>;
type Simplify<T> = {
    [K in keyof T]: T[K];
};
type ObjectOutput<P extends Record<string, PropertySchema>> = Simplify<{
    [K in RequiredKeys<P>]: Infer<UnwrapProperty<P[K]>>;
} & {
    [K in OptionalKeys<P>]?: Infer<UnwrapProperty<P[K]>>;
}>;
type ObjectPropertySchemas<P extends Record<string, PropertySchema>> = {
    readonly [K in keyof P]: UnwrapProperty<P[K]>["jsonSchema"];
};
type ObjectJsonSchema<P extends Record<string, PropertySchema>> = {
    readonly type: "object";
    readonly properties: ObjectPropertySchemas<P>;
    readonly required: readonly RequiredKeys<P>[];
    readonly additionalProperties: false;
};
export declare function schema<const T, const J extends JsonSchema>(jsonSchema: J, is: (value: unknown) => value is T): Schema<T, J>;
export declare function literal<const V extends JsonPrimitive>(value: V): Schema<V, {
    readonly const: V;
}>;
export declare const string: Schema<string, {
    readonly type: "string";
}>;
export declare const timestamp: Schema<string, {
    readonly type: "string";
    readonly format: "date-time";
}>;
export declare const boolean: Schema<boolean, {
    readonly type: "boolean";
}>;
export declare const nonNegativeInteger: Schema<number, {
    readonly type: "integer";
    readonly minimum: 0;
    readonly maximum: number;
}>;
export declare const positiveInteger: Schema<number, {
    readonly type: "integer";
    readonly minimum: 1;
    readonly maximum: number;
}>;
export declare function boundedString(maxLength: number): Schema<string, {
    readonly type: "string";
    readonly maxLength: number;
}>;
export declare function patternedString<const Pattern extends string>(pattern: Pattern, expression: RegExp): Schema<string, {
    readonly type: "string";
    readonly pattern: Pattern;
}>;
export declare function enumeration<const Values extends readonly [string, ...string[]]>(...values: Values): Schema<Values[number], {
    readonly type: "string";
    readonly enum: Values;
}>;
export declare function optional<const S extends AnySchema>(valueSchema: S): OptionalSchema<S>;
export declare function array<const S extends AnySchema>(itemSchema: S): Schema<Infer<S>[], {
    readonly type: "array";
    readonly items: Readonly<Record<string, unknown>>;
}>;
export declare function nullable<const S extends AnySchema>(valueSchema: S): Schema<Infer<S> | null, {
    readonly oneOf: Readonly<Record<string, unknown>>[];
}>;
export declare function object<const P extends Readonly<Record<string, PropertySchema>>>(properties: P): Schema<ObjectOutput<P>, ObjectJsonSchema<P>>;
export declare function union<const Schemas extends readonly [AnySchema, ...AnySchema[]]>(...schemas: Schemas): Schema<Infer<Schemas[number]>, {
    readonly oneOf: Readonly<Record<string, unknown>>[];
}>;
export declare function unionFromRecord<const Schemas extends Readonly<Record<string, AnySchema>>>(schemas: Schemas): Schema<Infer<Schemas[keyof Schemas]>, {
    readonly oneOf: readonly Schemas[keyof Schemas]["jsonSchema"][];
}>;
export declare function projectUnionDiscriminator<const S extends AnySchema, const Name extends string, const Value extends string>(base: S, name: Name, value: Value): Schema<Infer<S>, {
    readonly type: "object";
    readonly properties: { readonly [K in Name]: {
        readonly const: Value;
    }; };
    readonly required: readonly Name[];
    readonly allOf: readonly [Readonly<Record<string, unknown>>];
}>;
export declare function isJsonObject(value: unknown): value is JsonObject;
export declare function isJsonValue(value: unknown): value is JsonValue;
/**
 * Convert an arbitrary JavaScript value into a canonical {@link JsonValue},
 * matching `JSON.stringify` semantics: object keys whose value is `undefined`
 * are dropped, `undefined` array elements and non-finite numbers become `null`,
 * and any `toJSON()` method is honored. The result always satisfies
 * {@link isJsonValue}.
 *
 * SDK objects (session events and messages) idiomatically carry optional fields
 * set to `undefined` — a toolResult message has `usage: undefined`. Such a value
 * is NOT a JsonValue, so casting it straight into a stream frame makes the frame
 * fail canonical validation on send. Every boundary that lifts an SDK object
 * into a protocol frame must canonicalize it first.
 */
export declare function canonicalizeJsonValue(value: unknown): JsonValue;
export declare const jsonValue: Schema<JsonValue, {
    readonly $ref: "#/$defs/JsonValue";
}>;
export declare const jsonObject: Schema<JsonObject, {
    readonly type: "object";
    readonly additionalProperties: {
        readonly $ref: "#/$defs/JsonValue";
    };
}>;
export declare const JSON_VALUE_DEFINITION: {
    readonly oneOf: readonly [{
        readonly type: "null";
    }, {
        readonly type: "boolean";
    }, {
        readonly type: "number";
    }, {
        readonly type: "string";
    }, {
        readonly type: "array";
        readonly items: {
            readonly $ref: "#/$defs/JsonValue";
        };
    }, {
        readonly type: "object";
        readonly additionalProperties: {
            readonly $ref: "#/$defs/JsonValue";
        };
    }];
};
export {};
//# sourceMappingURL=schema.d.ts.map