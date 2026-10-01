// Execute real application code; no duplicate decision rules here.
import { STATES, decideTransition } from '../../src/session.ts';
for (const from of STATES)
  for (const to of STATES)
    console.log(`${from}->${to} ${decideTransition(from, to)}`);
