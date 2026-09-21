import fc from "fast-check";

// Every property test in this project runs a minimum of 100 cases, per
// design.md "Testing Strategy". Individual tests may raise this with a
// local `{ numRuns }` parameter but must not lower it below this floor.
fc.configureGlobal({ numRuns: 100 });
