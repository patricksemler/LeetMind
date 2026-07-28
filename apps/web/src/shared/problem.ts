import { z } from "zod";
import { type ParamTypeAst, type Signature, SignatureSchema, parseParamType } from "./signature";
import { HintLevel } from "./concepts";

/** Mirrors a row built for `problem_versions.content.hidden_tests`. Never served to the client. */
export const TestCaseSchema = z.object({
  args: z.array(z.unknown()),
  expected: z.unknown(),
  origin: z.enum(["example", "random", "boundary", "adversarial"]),
  // `.nullish()`, not `.optional()`. The content plane is Python: pydantic serializes an unset
  // `int | None` as JSON `null`, and jsonb round-trips that null rather than dropping the key —
  // so `.optional()` (which accepts only `undefined`) rejects perfectly valid stored content.
  // Accept null on the wire, normalize to undefined for TS consumers.
  seed: z
    .number()
    .int()
    .nullish()
    .transform((v) => v ?? undefined),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

const ExampleSchema = z.object({
  args: z.array(z.unknown()),
  expected: z.unknown(),
  explanation: z.string(),
});

const ProblemConceptRefSchema = z.object({
  id: z.string(),
  role: z.enum(["primary", "secondary"]),
  weight: z.number().min(0).max(1),
});

/**
 * The **full** ProblemVersion, including server-only fields (`hidden_tests`, `mutants_py`,
 * `reference_solution_py`, `brute_force_py`, `input_generator_py`, `checker_py`, `hints`). This is
 * what `problem_versions.content` stores. It must never be serialized directly to a client — only
 * `toPublicProblem()` may derive a client-safe projection from it.
 */
/**
 * What a problem asks you to *produce*, as opposed to which technique solves it — the concept
 * taxonomy answers the second question and nothing answered the first. Selecting a transfer
 * problem ("same concept, different form") is impossible without this axis: Two Sum and Subarray
 * Sum Equals K are both `arrays_hashing`, and only one of them is a useful transfer test of the
 * other. Mirrors the `problem_versions.shape` check constraint in migration 007 exactly.
 */
export const ProblemShape = z.enum([
  "find_pair",
  "count_occurrences",
  "find_extremum",
  "check_property",
  "build_output",
  "in_place_transform",
  "simulate_process",
  "partition_group",
  "path_or_order",
  "optimize_value",
]);
export type ProblemShape = z.infer<typeof ProblemShape>;

export const ProblemVersionSchema = z
  .object({
    problem_id: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
    internal_name: z.string(),
    statement_md: z.string(),
    constraints_md: z.string(),
    signature: SignatureSchema,
    examples: z.array(ExampleSchema).min(1),
    concepts: z.array(ProblemConceptRefSchema).min(1),
    difficulty: z.object({
      rating: z.number().int(),
      confidence: z.enum(["generated", "verified", "calibrated"]),
    }),
    expected_active_minutes: z.tuple([z.number().int(), z.number().int()]),
    // Nullish, like `reference_solution_cpp` below: Python emits `null` for an unset optional, and
    // every problem version generated before migration 007 has no shape at all. Consumers must
    // degrade (see `ListApprovedUnattemptedFilter.shape` in the API) rather than assume one.
    shape: ProblemShape.nullish().transform((v) => v ?? undefined),
    target_complexity: z.object({ time: z.string(), space: z.string() }),
    reference_solution_py: z.string(),
    // The C++ counterpart shown alongside Python in the post-reveal solution view. Optional and
    // nullish for the same reason as `checker_py` below: Python emits `null` for an unset optional,
    // and every problem version generated before this field existed simply has no C++ reference.
    // Consumers must degrade to Python-only rather than assume both languages are present.
    reference_solution_cpp: z
      .string()
      .nullish()
      .transform((v) => v ?? undefined),
    brute_force_py: z.string(),
    input_generator_py: z.string(),
    comparator: z.enum(["exact", "float_tol", "unordered", "checker_py"]),
    // See the note on TestCaseSchema.seed: Python emits `null` for an unset optional, so this must
    // be nullish. A `.optional()` here sent every checker-less problem's judge job to `dead` after
    // 3 attempts — found by scripts/demo.sh, not by any unit test.
    checker_py: z
      .string()
      .nullish()
      .transform((v) => v ?? undefined),
    hidden_tests: z.array(TestCaseSchema).default([]), // SERVER ONLY
    mutants_py: z.array(z.string()).default([]), // SERVER ONLY
    hints: z.object({
      l1_orientation: z.string(),
      l2_conceptual: z.string(),
      l3_structural: z.string(),
      outline: z.string(),
      editorial_md: z.string(),
    }),
    provenance: z.object({
      mode: z.enum(["novel", "template", "composed"]),
      model: z.string(),
      prompt_version: z.string(),
      generated_at: z.string(),
    }),
    state: z.enum(["candidate", "verifying", "approved", "rejected", "retired"]),
  })
  // Mirrors the content generator’s `ProblemVersion` validators exactly —
  // those two invariants were enforced ONLY on the Python (generation/verification) side; nothing
  // stopped a row that violated them from being read back and trusted by every TS consumer
  // (the API and the judge) once it was in the database.
  .superRefine((content, ctx) => {
    const totalWeight = content.concepts.reduce((sum, c) => sum + c.weight, 0);
    if (Math.abs(totalWeight - 1.0) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["concepts"],
        message: `concept weights must sum to ~1.0 (±0.01); got ${totalWeight}`,
      });
    }
    const primaryCount = content.concepts.filter((c) => c.role === "primary").length;
    if (primaryCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["concepts"],
        message: `exactly one concept must have role='primary'; got ${primaryCount}`,
      });
    }
  });
export type ProblemVersion = z.infer<typeof ProblemVersionSchema>;

/**
 * The ONLY problem shape the API may serialize to a client. Built exclusively by
 * `toPublicProblem()` — nothing else may construct this object.
 */
export const PublicProblemSchema = z.object({
  problem_version_id: z.string(),
  problem_id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  statement_md: z.string(),
  constraints_md: z.string(),
  signature: SignatureSchema,
  examples: z.array(ExampleSchema),
  difficulty_rating: z.number().int(),
  expected_active_minutes: z.tuple([z.number().int(), z.number().int()]),
  // The reference solution's complexity, shown in the statement as the target to aim for. This is
  // the one field promoted out of the post-solve `reveal` payload into the pre-solve problem: it
  // states the bar without hinting at the technique that meets it, the same way a LeetCode
  // "can you do it in O(n)?" follow-up does.
  target_complexity: z.object({ time: z.string(), space: z.string() }),
  comparator: z.enum(["exact", "float_tol", "unordered", "checker_py"]),
  starter_code: z.object({ python: z.string(), cpp: z.string() }),
  hint_levels_available: z.array(HintLevel),
  concepts_revealed: z.union([z.null(), z.array(ProblemConceptRefSchema)]),
});
export type PublicProblem = z.infer<typeof PublicProblemSchema>;

const HINT_LEVEL_ORDER: readonly HintLevel[] = [
  "l1_orientation",
  "l2_conceptual",
  "l3_structural",
  "outline",
  "editorial",
];

export interface ToPublicProblemInput {
  problemVersionId: string;
  content: ProblemVersion;
  hintsTaken: string[];
  revealConcepts: boolean;
}

/**
 * The single, exclusive constructor of `PublicProblem`. Builds a fresh object naming only
 * whitelisted fields — it never spreads `content` — so `hidden_tests`, `mutants_py`,
 * `reference_solution_py`, `brute_force_py`, `input_generator_py`, `checker_py`, and hint *text*
 * (taken or not) can never leak through it. See docs/CONTRACTS.md §4.2 and §9.
 */
export function toPublicProblem(input: ToPublicProblemInput): PublicProblem {
  const { problemVersionId, content, hintsTaken, revealConcepts } = input;
  const taken = new Set(hintsTaken);

  return {
    problem_version_id: problemVersionId,
    problem_id: content.problem_id,
    version: content.version,
    title: content.title,
    statement_md: content.statement_md,
    constraints_md: content.constraints_md,
    signature: content.signature,
    examples: content.examples,
    difficulty_rating: content.difficulty.rating,
    expected_active_minutes: content.expected_active_minutes,
    target_complexity: content.target_complexity,
    comparator: content.comparator,
    starter_code: {
      python: starterCodeFor(content.signature, "python"),
      cpp: starterCodeFor(content.signature, "cpp"),
    },
    hint_levels_available: HINT_LEVEL_ORDER.filter((level) => !taken.has(level)),
    concepts_revealed: revealConcepts ? content.concepts : null,
  };
}

// --- starter code generation --------------------------------------------------------------

function cppType(ast: ParamTypeAst): string {
  switch (ast.kind) {
    case "scalar":
      switch (ast.name) {
        case "int":
          return "long long";
        case "float":
          return "double";
        case "bool":
          return "bool";
        case "str":
          return "std::string";
      }
      break;
    case "list":
      return `std::vector<${cppType(ast.of)}>`;
    case "tree":
      return "TreeNode*";
    case "linkedlist":
      return "ListNode*";
  }
}

function pythonType(ast: ParamTypeAst): string {
  switch (ast.kind) {
    case "scalar":
      switch (ast.name) {
        case "int":
          return "int";
        case "float":
          return "float";
        case "bool":
          return "bool";
        case "str":
          return "str";
      }
      break;
    case "list":
      return `List[${pythonType(ast.of)}]`;
    case "tree":
      return ast.nullable ? "Optional[TreeNode]" : "TreeNode";
    case "linkedlist":
      return ast.nullable ? "Optional[ListNode]" : "ListNode";
  }
}

/**
 * Generates a starter-code stub for the editor. Python: a bare top-level `def <name>(...)`
 * (matching the harness, which imports `solution.py` and calls `signature.name` directly — no
 * enclosing class). C++: `class Solution { public: <ret> <name>(<args>) { } };` (M4 harness type
 * mapping, docs/CONTRACTS.md §7): `int→long long, float→double, bool→bool, str→std::string,
 * list[T]→std::vector<T>, TreeNode→TreeNode*, ListNode→ListNode*`.
 */
export function starterCodeFor(signature: Signature, language: "python" | "cpp"): string {
  const params = signature.params.map((p) => ({ name: p.name, ast: parseParamType(p.type) }));
  const returns = parseParamType(signature.returns);

  if (language === "python") {
    const paramList = params.map((p) => `${p.name}: ${pythonType(p.ast)}`).join(", ");
    return (
      `from typing import List, Optional\n\n\n` +
      `def ${signature.name}(${paramList}) -> ${pythonType(returns)}:\n` +
      `    pass\n`
    );
  }

  const paramList = params.map((p) => `${cppType(p.ast)} ${p.name}`).join(", ");
  return (
    `class Solution {\n` +
    `public:\n` +
    `    ${cppType(returns)} ${signature.name}(${paramList}) {\n` +
    `        \n` +
    `    }\n` +
    `};\n`
  );
}
