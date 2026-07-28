/**
 * The API's wire contract (PLAN_BACKEND.md §10): `api-types.d.ts` is generated from the server's
 * OpenAPI schema by `pnpm gen:api` and never hand-edited. This file re-exports the shapes the app
 * actually uses under stable names, so the rest of `src/` imports from `@shared` rather than
 * reaching into `components["schemas"][...]` everywhere — and picks up server-side renames as
 * compile errors here instead of scattered across every consumer.
 */
import type { components } from "./api-types";

export type TypeProfileView = components["schemas"]["TypeProfileView"];
export type MeResponse = components["schemas"]["MeResponse"];

export type GenerationJobStatus = components["schemas"]["GenerationJobStatus"];
export type JobStub = components["schemas"]["JobStub"];
export type PracticeNextResponse = components["schemas"]["PracticeNextResponse"];
export type ReplenishResponse = components["schemas"]["ReplenishResponse"];

export type ValueType = components["schemas"]["ValueType"];
export type SignatureParam = components["schemas"]["SignatureParam"];
export type Signature = components["schemas"]["Signature"];
export type Complexity = components["schemas"]["Complexity"];
export type TestCaseView = components["schemas"]["TestCaseView"];

export type ProblemView = components["schemas"]["ProblemView"];
export type ResolvedProblemView = components["schemas"]["ResolvedProblemView"];
/** The union `GET/POST /problems/{id}(/open)` actually returns — resolved once solved/given-up. */
export type ProblemDetail = ProblemView | ResolvedProblemView;

export type CodeRequest = components["schemas"]["CodeRequest"];
export type Verdict = components["schemas"]["Verdict"];
export type TestOutcome = components["schemas"]["TestOutcome"];
export type RunResponse = components["schemas"]["RunResponse"];
export type FailingCaseView = components["schemas"]["FailingCaseView"];
export type RatingUpdateView = components["schemas"]["RatingUpdateView"];
export type SubmitResponse = components["schemas"]["SubmitResponse"];
export type HintResponse = components["schemas"]["HintResponse"];
export type GiveUpResponse = components["schemas"]["GiveUpResponse"];

export type RatingHistoryPoint = components["schemas"]["RatingHistoryPoint"];
export type ResolvedProblemSummary = components["schemas"]["ResolvedProblemSummary"];
export type ProgressResponse = components["schemas"]["ProgressResponse"];

export * from "./events";

/** Narrows `ProblemDetail` to the resolved view — present only once status is solved/given-up
 * (§9): private tests, the full hint ladder, and the reference solution. */
export function isResolved(problem: ProblemDetail): problem is ResolvedProblemView {
  return "reference_solution" in problem;
}
