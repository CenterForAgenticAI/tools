export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface Schema<out T, out J extends JsonSchema = JsonSchema> {
  readonly jsonSchema: J;
  readonly is: (value: unknown) => value is T;
}

export type Infer<S extends Schema<unknown>> = S extends Schema<infer T>
  ? T
  : never;

type AnySchema = Schema<unknown>;

interface OptionalSchema<S extends AnySchema> {
  readonly optional: true;
  readonly schema: S;
}

type PropertySchema = AnySchema | OptionalSchema<AnySchema>;

type UnwrapProperty<P extends PropertySchema> = P extends OptionalSchema<
  infer S
>
  ? S
  : P;

type OptionalKeys<P extends Record<string, PropertySchema>> = {
  [K in keyof P]: P[K] extends OptionalSchema<AnySchema> ? K : never;
}[keyof P];

type RequiredKeys<P extends Record<string, PropertySchema>> = Exclude<
  keyof P,
  OptionalKeys<P>
>;

type Simplify<T> = { [K in keyof T]: T[K] };

type ObjectOutput<P extends Record<string, PropertySchema>> = Simplify<
  { [K in RequiredKeys<P>]: Infer<UnwrapProperty<P[K]>> } & {
    [K in OptionalKeys<P>]?: Infer<UnwrapProperty<P[K]>>;
  }
>;

type ObjectPropertySchemas<P extends Record<string, PropertySchema>> = {
  readonly [K in keyof P]: UnwrapProperty<P[K]>["jsonSchema"];
};

type ObjectJsonSchema<P extends Record<string, PropertySchema>> = {
  readonly type: "object";
  readonly properties: ObjectPropertySchemas<P>;
  readonly required: readonly RequiredKeys<P>[];
  readonly additionalProperties: false;
};

export function schema<const T, const J extends JsonSchema>(
  jsonSchema: J,
  is: (value: unknown) => value is T,
): Schema<T, J> {
  return { jsonSchema, is };
}

export function literal<const V extends JsonPrimitive>(value: V) {
  return schema({ const: value } as const, (candidate): candidate is V =>
    Object.is(candidate, value),
  );
}

export const string = schema(
  { type: "string" } as const,
  (value): value is string => typeof value === "string",
);

const ISO_8601_TIMESTAMP =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isIso8601Timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_8601_TIMESTAMP.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = month === 2 && leapYear ? 29 : monthLengths[month - 1];
  return maxDay !== undefined && day <= maxDay;
}

export const timestamp = schema(
  { type: "string", format: "date-time" } as const,
  isIso8601Timestamp,
);

export const boolean = schema(
  { type: "boolean" } as const,
  (value): value is boolean => typeof value === "boolean",
);

export const nonNegativeInteger = schema(
  {
    type: "integer",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  } as const,
  (value): value is number => Number.isSafeInteger(value) && Number(value) >= 0,
);

export const positiveInteger = schema(
  {
    type: "integer",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  } as const,
  (value): value is number => Number.isSafeInteger(value) && Number(value) >= 1,
);

export function boundedString(maxLength: number) {
  return schema(
    { type: "string", maxLength } as const,
    (value): value is string =>
      typeof value === "string" && [...value].length <= maxLength,
  );
}

export function patternedString<const Pattern extends string>(
  pattern: Pattern,
  expression: RegExp,
) {
  return schema(
    { type: "string", pattern } as const,
    (value): value is string =>
      typeof value === "string" && expression.test(value),
  );
}

export function enumeration<
  const Values extends readonly [string, ...string[]],
>(...values: Values) {
  const members = new Set<string>(values);
  return schema(
    { type: "string", enum: values } as const,
    (value): value is Values[number] =>
      typeof value === "string" && members.has(value),
  );
}

export function optional<const S extends AnySchema>(
  valueSchema: S,
): OptionalSchema<S> {
  return { optional: true, schema: valueSchema };
}

export function array<const S extends AnySchema>(itemSchema: S) {
  return schema(
    { type: "array", items: itemSchema.jsonSchema } as const,
    (value): value is Infer<S>[] =>
      Array.isArray(value) && value.every((item) => itemSchema.is(item)),
  );
}

export function nullable<const S extends AnySchema>(valueSchema: S) {
  return union(valueSchema, literal(null));
}

export function object<
  const P extends Readonly<Record<string, PropertySchema>>,
>(properties: P): Schema<ObjectOutput<P>, ObjectJsonSchema<P>> {
  const propertyEntries = Object.entries(properties);
  const propertySchemas = Object.fromEntries(
    propertyEntries.map(([key, property]) => [
      key,
      "optional" in property ? property.schema.jsonSchema : property.jsonSchema,
    ]),
  ) as ObjectPropertySchemas<P>;
  const required = propertyEntries
    .filter(([, property]) => !("optional" in property))
    .map(([key]) => key) as RequiredKeys<P>[];
  const allowed = new Set(Object.keys(properties));

  const jsonSchema: ObjectJsonSchema<P> = {
    type: "object",
    properties: propertySchemas,
    required,
    additionalProperties: false,
  };

  return schema(jsonSchema, (value): value is ObjectOutput<P> => {
    if (!isJsonObject(value)) return false;
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;

    return propertyEntries.every(([key, property]) => {
      const present = Object.hasOwn(value, key);
      if (!present) return "optional" in property;
      const valueSchema = "optional" in property ? property.schema : property;
      return valueSchema.is(value[key]);
    });
  });
}

export function union<
  const Schemas extends readonly [AnySchema, ...AnySchema[]],
>(...schemas: Schemas) {
  return schema(
    { oneOf: schemas.map((member) => member.jsonSchema) } as const,
    (value): value is Infer<Schemas[number]> =>
      schemas.filter((member) => member.is(value)).length === 1,
  );
}

export function unionFromRecord<
  const Schemas extends Readonly<Record<string, AnySchema>>,
>(schemas: Schemas) {
  const members = Object.values(schemas);
  return schema(
    {
      oneOf: members.map((member) => member.jsonSchema) as readonly Schemas[keyof Schemas]["jsonSchema"][],
    } as const,
    (value): value is Infer<Schemas[keyof Schemas]> =>
      members.filter((member) => member.is(value)).length === 1,
  );
}

export function projectUnionDiscriminator<
  const S extends AnySchema,
  const Name extends string,
  const Value extends string,
>(base: S, name: Name, value: Value) {
  const jsonSchema = {
    type: "object",
    properties: { [name]: { const: value } } as {
      readonly [K in Name]: { readonly const: Value };
    },
    required: [name] as readonly Name[],
    allOf: [base.jsonSchema] as const,
  } as const;
  return schema<Infer<S>, typeof jsonSchema>(
    jsonSchema,
    base.is as (value: unknown) => value is Infer<S>,
  );
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

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
export function canonicalizeJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : canonicalizeJsonValue(item),
    );
  }
  if (typeof value === "object") {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === "function") {
      return canonicalizeJsonValue(withToJson.toJSON());
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      result[key] = canonicalizeJsonValue(item);
    }
    return result;
  }
  // undefined, function, symbol, bigint: no JSON representation.
  return null;
}

export const jsonValue = schema(
  { $ref: "#/$defs/JsonValue" } as const,
  isJsonValue,
);

export const jsonObject = schema(
  {
    type: "object",
    additionalProperties: { $ref: "#/$defs/JsonValue" },
  } as const,
  isJsonObject,
);

export const JSON_VALUE_DEFINITION = {
  oneOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: { $ref: "#/$defs/JsonValue" } },
    {
      type: "object",
      additionalProperties: { $ref: "#/$defs/JsonValue" },
    },
  ],
} as const;
