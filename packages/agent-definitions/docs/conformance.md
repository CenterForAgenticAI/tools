# Conformance suite

The conformance suite checks whether another project reads agent definitions the same way as the reference parser. It is framework-neutral and can run inside `node:test`, Vitest, Jest, or another test runner.

## Run the suite

Import the dedicated test entry point. Replace `<installed-package>` with the package name used by your project.

```ts
import { parseDefinition } from "<installed-package>";
import { assertConformance, type ConformanceConsumer } from "<installed-package>/conformance";

const consumer: ConformanceConsumer = {
	name: "my-adapter",
	parse(source, options) {
		return myAdapter.parse(source, options);
	},
};

await assertConformance(consumer, { level: "parses" });
```

`runConformance(consumer, options)` returns a report instead of throwing. Use it when the test framework needs to render failures itself. `assertConformance(consumer, options)` throws one error that lists every fixture and path that did not match.

The report's `checked` field counts fixture parses. At the `enforces` level, it also counts each valid-fixture preparation and three preparation probes.

## Consumer interface

```ts
interface ConformanceConsumer {
	name: string;
	parse(source: string, options: ParseOptions): ConsumerParse | Promise<ConsumerParse>;
	prepare?(definition: AgentDefinition, request: PrepareRequest): PrepareResult | Promise<PrepareResult>;
}

type ConsumerParse = {
	ok: boolean;
	definition?: unknown;
	diagnostics: {
		severity: "error" | "warning" | "hint";
		path: string;
	}[];
};

interface PrepareRequest {
	runtime: string;
	requestedIsolation: "shared" | "worktree" | "ephemeral";
	isolationGrant?: IsolationDowngradeGrant;
}

type PrepareResult = { ok: true; enforced: { path: string; value: unknown }[] } | { ok: false; reason: string };
```

`prepare` receives the canonical definition and the run request. An accepted result lists the restrictions the consumer enforces, using the canonical path and value. A consumer that cannot enforce a restriction must return a refusal. A refusal reason is descriptive; the suite does not interpret it.

## Levels

### `parses`

For every manifest entry except converter inputs, the suite runs the package's parser and the consumer over the same source and options. It compares:

- the `ok` result;
- sorted error paths and warning paths, including duplicate counts;
- the complete canonical definition when parsing succeeds.

The fixture manifest still contains independent, hand-written checks for the reference parser. The runner does not write or read generated expected-result files.

### `enforces`

This level includes every `parses` check and requires `prepare`. For every valid definition, it checks the consumer's self-reported coverage of:

- an explicit `tools` list;
- non-empty `disallowedTools`;
- a restricted `agents` list;
- non-shared workspace isolation;
- turn and timeout limits;
- every required skill;
- every required runtime.

The suite also supplies a definition that contains every restriction, asks for looser isolation without a grant, and asks a different runtime to prepare a runtime-specific definition. The last two requests must be refused.

The `enforces` level proves that the consumer reports every restriction and rejects the two unsafe requests. It does not launch an agent, inspect a sandbox, or prove that the runtime keeps its promises during execution.

## Non-JavaScript consumers

The installed package includes `fixtures/manifest.json` and every fixture source. A non-JavaScript project can invoke a small Node helper during its tests. The helper runs the reference parser over each non-converter fixture and writes the parse result as JSON to standard output. Send the same source and manifest options to the non-JavaScript parser, then compare `ok`, diagnostic paths, and the complete definition in memory.

Do not commit generated expected-result files. Keep the manifest's hand-written expectations as the independent check on the reference parser.
