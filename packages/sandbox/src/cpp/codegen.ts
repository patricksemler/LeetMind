/**
 * C++ harness codegen — CONTRACTS §7.
 *
 * Generates a single self-contained `main.cpp` from a typed `Signature`, mirroring the behaviour
 * of `packages/sandbox/runners/python/runner.py` (the reference implementation of the harness
 * protocol) as closely as C++'s static type system allows:
 *
 *   - parses `/bundle/tests.json` (nlohmann `json.hpp`, vendored at
 *     `packages/sandbox/runners/cpp/json.hpp`)
 *   - decodes each test's `args` into the mapped C++ types (building `TreeNode`/`ListNode` with
 *     the SAME LeetCode-style encodings `runner.py` uses), calls `Solution::<name>`, times the
 *     call with `std::chrono::steady_clock`, captures that test's `std::cout` into an
 *     `std::ostringstream` (truncated to 4KB), encodes the return value back to JSON, and compares
 *     it against the bundled expected value with the same comparator semantics as `runner.py`
 *     (`exact`, `float_tol` abs+rel 1e-6, `unordered` — recursive multiset via canonical-key sort)
 *   - enforces a per-test time budget (a detached pthread with a large stack, matching
 *     `runner.py`'s `threading.stack_size` — see `THREAD_STACK_SIZE` below) and emits exactly one
 *     `<<<LEETMIND_RESULT>>>` sentinel line followed by one JSON object, identical in shape to the
 *     Python harness's protocol. `expected` is never emitted.
 *   - a test whose bundled case has no `expected` key (CONTRACTS §4.5 — `run` against
 *     `custom_input`) is reported `status: "completed"` rather than compared at all.
 *
 * Type mapping (CONTRACTS §7): `int -> long long`, `float -> double`, `bool -> bool`,
 * `str -> std::string`, `list[T] -> std::vector<T>` (nested), `TreeNode -> TreeNode*`,
 * `ListNode -> ListNode*`. The signature format doesn't parametrize a tree/list node's *value*
 * type, so — consistent with the `int -> long long` rule, and since every NeetCode-style
 * tree/list problem in this system's type universe holds integers — `TreeNode`/`ListNode` values
 * are generated as `long long`, exactly mirroring Python's `TreeNode.val: Any` holding whatever
 * JSON numbers `tests.json` supplies.
 *
 * `checker_py` is Python-only: `executeCpp` (./execute.ts) rejects it with `internal_error`
 * BEFORE ever building a bundle or invoking the sandbox — this module never needs to generate
 * code for it, and `main.cpp`'s own comparator dispatcher throws if it's somehow reached anyway
 * (defense in depth, converted to a top-level `harness_error` by `main()`'s outer catch).
 */
import { parseParamType, type ParamTypeAst, type Signature } from "@leetmind/shared";
import { STATIC_HARNESS, STATIC_PRELUDE } from "./harnessTemplate.js";

/** Maps a parsed `ParamTypeAst` to its C++ type spelling — CONTRACTS §7's type table, applied
 * recursively so `list[list[int]]` -> `std::vector<std::vector<long long>>`. */
export function cppType(ast: ParamTypeAst): string {
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
  // Exhaustive per ParamTypeAst's union — TS can't prove it through the nested switch's scalar
  // arm, so this is an explicit backstop rather than a silent `undefined`.
  throw new Error(`cppType: unhandled ParamTypeAst ${JSON.stringify(ast)}`);
}

/** A bare C++/JSON identifier — matches the C++ standard grammar closely enough for this purpose:
 * a letter or underscore, then any run of letters/digits/underscores. */
const CPP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Generates the full `main.cpp` translation unit for a given problem `Signature`. Deterministic —
 * the same `Signature` always produces byte-identical output, which is what makes it snapshottable
 * in unit tests without Docker.
 */
export function generateMainCpp(signature: Signature): string {
  // `signature.name` is spliced directly into generated, COMPILED code as
  // `solution_instance.${signature.name}(...)` below — unlike `param.name` (comments only), this
  // one is a real code-injection point. `signature` comes from LLM-generated problem content,
  // which this system's own threat model treats as untrusted; a malformed or adversarial name
  // (e.g. containing `();` or a raw `//`) would otherwise land straight in a compiled, executed
  // C++ translation unit. Fail loudly here rather than let the compiler (or worse, the compiler
  // successfully accepting something unintended) be the first thing to notice.
  if (!CPP_IDENTIFIER.test(signature.name)) {
    throw new Error(
      `generateMainCpp: signature.name is not a valid identifier: ${JSON.stringify(signature.name)}`,
    );
  }

  const paramAsts = signature.params.map((p) => parseParamType(p.type));
  const paramTypes = paramAsts.map(cppType);
  const returnAst = parseParamType(signature.returns);
  const returnType = cppType(returnAst);

  const decodeLines = paramTypes
    .map((t, i) => `    auto arg${i} = Codec<${t}>::decode(args_json.at(${i}));`)
    .join("\n");
  const callArgs = paramTypes.map((_, i) => `arg${i}`).join(", ");

  const callSolution = `
// ---------------------------------------------------------------------------
// Generated for this problem's signature: ${signature.name}(${signature.params
    .map((p) => `${p.name}: ${p.type}`)
    .join(", ")}) -> ${signature.returns}
// ---------------------------------------------------------------------------
json call_solution(const json& args_json) {
${decodeLines}
    Solution solution_instance;
    auto result = solution_instance.${signature.name}(${callArgs});
    return Codec<${returnType}>::encode(result);
}
`;

  return `// Generated by packages/sandbox/src/cpp/codegen.ts — CONTRACTS §7. DO NOT EDIT BY HAND.
// Signature: ${signature.name}(${signature.params.map((p) => `${p.name}: ${p.type}`).join(", ")}) -> ${signature.returns}
#include <bits/stdc++.h>
#include <pthread.h>
#include <cxxabi.h>
#include <sys/resource.h>
#include "json.hpp"

using json = nlohmann::json;
${STATIC_PRELUDE}
#include "solution.cpp"

// Forward declaration: the per-signature call_solution below needs Codec<T> (defined in the
// harness block that follows), but the harness's worker-thread entry point needs to call
// call_solution — this breaks the cycle without reordering either block.
json call_solution(const json& args_json);
${STATIC_HARNESS}
${callSolution}
int main(int argc, char** argv) {
    std::string bundle_dir = argc > 1 ? std::string(argv[1]) : std::string("/bundle");
    try {
        run_harness(bundle_dir);
    } catch (const std::exception& e) {
        emit_result(json{{"ok", false},
                          {"error_kind", "harness_error"},
                          {"error", scrub_paths(std::string("internal harness error: ") + e.what())},
                          {"tests", json::array()}});
    } catch (...) {
        emit_result(json{{"ok", false},
                          {"error_kind", "harness_error"},
                          {"error", "internal harness error: unrecognized exception"},
                          {"tests", json::array()}});
    }
    return 0;
}
`;
}
