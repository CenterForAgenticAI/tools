import { Type, type Static } from "typebox";

const nonEmpty = { minLength: 1 } as const;
const closed = { additionalProperties: false } as const;
const agentInputPathFormat = "agent-input-path";

export const LinkSchema = Type.Object({
	url: Type.String(nonEmpty),
	note: Type.Optional(Type.String()),
}, closed);

export const LineageSchema = Type.Object({
	spec: Type.String(nonEmpty),
	reason: Type.String(),
}, closed);

export const OpenDecisionSchema = Type.Object({
	id: Type.String(nonEmpty),
	question: Type.String(),
	tripwire: Type.String(),
	decides: Type.String(nonEmpty),
}, closed);

/**
 * An advisory a spec author has considered and accepted, with the reason a reviewer
 * reads. Modelled on the criterion amendment record: an act with a named authority
 * and a timestamp, never a silent flag.
 *
 * It cannot reach an error. Dispositioning an error would be exactly the blanket
 * suppression this field exists instead of.
 */
export const AdvisoryDispositionSchema = Type.Object({
	/** The advisory finding code this accepts, for example touches-concentration. */
	code: Type.String(nonEmpty),
	/** The specific subject the advisory named, so one reason cannot cover a whole class. */
	target: Type.String(nonEmpty),
	reason: Type.String(nonEmpty),
	authority: Type.String(nonEmpty),
	at: Type.String(nonEmpty),
}, closed);

export const RefSchema = Type.Object({
	path: Type.String(nonEmpty),
	lines: Type.Optional(Type.String()),
	why: Type.String(),
}, closed);

/** The complete execution block in Workspec v2. No other keys are permitted. */
export const WorkerSchema = Type.Object({
	profile: Type.Optional(Type.String(nonEmpty)),
	agent: Type.Optional(Type.String(nonEmpty)),
	skills: Type.Optional(Type.Array(Type.String(nonEmpty))),
	model: Type.Optional(Type.String(nonEmpty)),
}, closed);

export const CommandExpectationSchema = Type.Object({
	exit: Type.Integer({ minimum: 0, maximum: 255 }),
	output_includes: Type.String(nonEmpty),
}, closed);

export const CommandEvidenceSchema = Type.Object({
	kind: Type.Literal("command"),
	run: Type.String(nonEmpty),
	expect: CommandExpectationSchema,
	timeout_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
}, closed);

export const AgentEvidenceSchema = Type.Object({
	kind: Type.Literal("agent"),
	agent: Type.String(nonEmpty),
	inputs: Type.Array(Type.String({ ...nonEmpty, format: agentInputPathFormat }), { minItems: 1 }),
	rubric: Type.String(nonEmpty),
}, closed);

export const UserEvidenceSchema = Type.Object({
	kind: Type.Literal("user"),
	prompt: Type.String(nonEmpty),
}, closed);

export const EvidenceSchema = Type.Union([
	CommandEvidenceSchema,
	AgentEvidenceSchema,
	UserEvidenceSchema,
]);

export const CriterionAmendmentSchema = Type.Object({
	criterion_id: Type.String(nonEmpty),
	before: Type.String(),
	after: Type.String(),
	reason: Type.String(nonEmpty),
	authority: Type.String(nonEmpty),
	at: Type.String(nonEmpty),
}, closed);

export const AcceptanceCriterionSchema = Type.Object({
	id: Type.String(nonEmpty),
	statement: Type.String(),
	amendments: Type.Optional(Type.Array(CriterionAmendmentSchema, { minItems: 1 })),
	evidence: EvidenceSchema,
}, closed);

const nodeFields = {
	id: Type.String(nonEmpty),
	task: Type.String(),
	description: Type.Optional(Type.String()),
	depends_on: Type.Optional(Type.Array(Type.String(nonEmpty))),
	touches: Type.Optional(Type.Array(Type.String(nonEmpty))),
	refs: Type.Optional(Type.Array(RefSchema)),
	worker: Type.Optional(WorkerSchema),
	acceptance: Type.Optional(Type.Array(AcceptanceCriterionSchema)),
};

const checklistNode = Type.Object({
	...nodeFields,
	acceptance: Type.Array(AcceptanceCriterionSchema, { minItems: 1 }),
	checklist: Type.Array(Type.String()),
	work: Type.Optional(Type.Never()),
}, closed);

const leafNode = Type.Object({
	...nodeFields,
	acceptance: Type.Array(AcceptanceCriterionSchema, { minItems: 1 }),
	checklist: Type.Optional(Type.Never()),
	work: Type.Optional(Type.Never()),
}, closed);
const compositeNode = Type.Object({
	...nodeFields,
	checklist: Type.Optional(Type.Never()),
	work: Type.Array(Type.Ref("WorkNode"), { minItems: 1 }),
}, closed);

/** The recursive runtime schema and its inferred recursive static type. */
export const WorkNodeSchema = Type.Cyclic({
	WorkNode: Type.Union([leafNode, checklistNode, compositeNode]),
}, "WorkNode");

export type WorkNode = Static<typeof WorkNodeSchema>;

export const WorkspecSchema = Type.Object({
	title: Type.String(),
	description: Type.String(),
	intent: Type.String(),
	links: Type.Optional(Type.Array(LinkSchema)),
	corrects: Type.Optional(Type.Array(LineageSchema)),
	supersedes: Type.Optional(Type.Array(LineageSchema)),
	open_decisions: Type.Optional(Type.Array(OpenDecisionSchema)),
	advisory_dispositions: Type.Optional(Type.Array(AdvisoryDispositionSchema, { minItems: 1 })),
	work: Type.Array(WorkNodeSchema),
}, closed);

export type Link = Static<typeof LinkSchema>;
export type Lineage = Static<typeof LineageSchema>;
export type OpenDecision = Static<typeof OpenDecisionSchema>;
export type AdvisoryDisposition = Static<typeof AdvisoryDispositionSchema>;
export type Ref = Static<typeof RefSchema>;
export type Worker = Static<typeof WorkerSchema>;
export type CommandExpectation = Static<typeof CommandExpectationSchema>;
export type CommandEvidence = Static<typeof CommandEvidenceSchema>;
export type AgentEvidence = Static<typeof AgentEvidenceSchema>;
export type UserEvidence = Static<typeof UserEvidenceSchema>;
export type Evidence = Static<typeof EvidenceSchema>;
export type CriterionAmendment = Static<typeof CriterionAmendmentSchema>;
export type AcceptanceCriterion = Static<typeof AcceptanceCriterionSchema>;
export type Workspec = Static<typeof WorkspecSchema>;

/** Keys of a union, rather than only keys common to every member. */
export type KeysOfUnion<T> = T extends T ? keyof T : never;
export type WorkNodeField = KeysOfUnion<WorkNode>;

/** A compile-time contract for downstream total projectors (issue #4). */
export type WorkNodeProjector<Handler> = Record<WorkNodeField, Record<"worker" | "review" | "remediation", Handler>>;
