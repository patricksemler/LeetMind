import { z } from "zod";

/**
 * ParamType grammar (docs/CONTRACTS.md §4.1):
 *
 *   int | float | bool | str
 *   | TreeNode | ListNode        (M3, non-nullable root)
 *   | TreeNode? | ListNode?      (M3, nullable root)
 *   | list[<ParamType>]          (arbitrarily nested, e.g. "list[list[int]]")
 */

export type ScalarName = "int" | "float" | "bool" | "str";

export type ParamTypeAst =
  | { kind: "scalar"; name: ScalarName }
  | { kind: "list"; of: ParamTypeAst }
  | { kind: "tree"; nullable: boolean }
  | { kind: "linkedlist"; nullable: boolean };

const SCALAR_RE = /^(int|float|bool|str)$/;
const TREE_NODE_RE = /^TreeNode(\?)?$/;
const LINKED_LIST_NODE_RE = /^ListNode(\?)?$/;
const LIST_WRAPPER_RE = /^list\[(.*)\]$/s;

/**
 * Parses a ParamType string into its AST. Throws with a descriptive message on invalid input.
 * Recursive: `list[...]` wrapping is peeled off one layer at a time via `LIST_WRAPPER_RE`, then
 * the inner string is parsed again — this is what gives arbitrary nesting support.
 */
export function parseParamType(input: string): ParamTypeAst {
  const value = typeof input === "string" ? input : "";

  if (SCALAR_RE.test(value)) {
    return { kind: "scalar", name: value as ScalarName };
  }

  const treeMatch = TREE_NODE_RE.exec(value);
  if (treeMatch) {
    return { kind: "tree", nullable: treeMatch[1] === "?" };
  }

  const listNodeMatch = LINKED_LIST_NODE_RE.exec(value);
  if (listNodeMatch) {
    return { kind: "linkedlist", nullable: listNodeMatch[1] === "?" };
  }

  const listMatch = LIST_WRAPPER_RE.exec(value);
  if (listMatch) {
    const inner = listMatch[1] ?? "";
    return { kind: "list", of: parseParamType(inner) };
  }

  throw new Error(`Invalid ParamType: "${input}"`);
}

/** True iff `input` parses as a valid ParamType. Never throws. */
export function isValidParamType(input: unknown): input is string {
  if (typeof input !== "string") return false;
  try {
    parseParamType(input);
    return true;
  } catch {
    return false;
  }
}

/** Renders an AST back to its canonical ParamType string. Useful for round-trip tests. */
export function paramTypeToString(ast: ParamTypeAst): string {
  switch (ast.kind) {
    case "scalar":
      return ast.name;
    case "list":
      return `list[${paramTypeToString(ast.of)}]`;
    case "tree":
      return ast.nullable ? "TreeNode?" : "TreeNode";
    case "linkedlist":
      return ast.nullable ? "ListNode?" : "ListNode";
  }
}

export const ParamTypeSchema = z.string().refine(isValidParamType, {
  message: "Invalid ParamType (expected int|float|bool|str|TreeNode[?]|ListNode[?]|list[<ParamType>])",
});

export const SignatureSchema = z.object({
  name: z.string().min(1),
  params: z.array(
    z.object({
      name: z.string().min(1),
      type: ParamTypeSchema,
    }),
  ),
  returns: ParamTypeSchema,
});

export type Signature = z.infer<typeof SignatureSchema>;
