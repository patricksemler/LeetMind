/**
 * Pure TS codecs for the `TreeNode` / `ListNode` JSON encodings used by the harness and the API.
 * docs/CONTRACTS.md §4.1: TreeNode → LeetCode-style level-order array with `null` holes
 * (`[1,2,3,null,null,4,5]`); ListNode → plain array (`[1,2,3]`).
 */

export interface TreeNodeLike {
  val: unknown;
  left: TreeNodeLike | null;
  right: TreeNodeLike | null;
}

export interface ListNodeLike {
  val: unknown;
  next: ListNodeLike | null;
}

/**
 * Encodes a binary tree to a LeetCode-style level-order array. Children of `null` nodes are never
 * visited (so the array does not blow up with placeholder descendants of missing nodes), and
 * trailing `null`s at the very end of the array are trimmed to match LeetCode's canonical
 * (compact) serialization.
 */
export function encodeTree(root: TreeNodeLike | null): Array<unknown | null> {
  if (root === null) return [];

  const out: Array<unknown | null> = [];
  const queue: Array<TreeNodeLike | null> = [root];

  while (queue.length > 0) {
    const node = queue.shift() ?? null;
    if (node === null) {
      out.push(null);
      continue;
    }
    out.push(node.val);
    queue.push(node.left);
    queue.push(node.right);
  }

  while (out.length > 0 && out[out.length - 1] === null) {
    out.pop();
  }

  return out;
}

/**
 * Decodes a LeetCode-style level-order array (with or without the trailing-null trim applied) back
 * into a `TreeNodeLike` tree. Missing entries past the end of `arr` are treated as `null`.
 */
export function decodeTree(arr: ReadonlyArray<unknown | null>): TreeNodeLike | null {
  if (arr.length === 0 || arr[0] === null || arr[0] === undefined) return null;

  const root: TreeNodeLike = { val: arr[0], left: null, right: null };
  const queue: TreeNodeLike[] = [root];
  let i = 1;

  while (queue.length > 0 && i < arr.length) {
    const node = queue.shift();
    if (!node) break;

    if (i < arr.length) {
      const leftVal = arr[i++];
      if (leftVal !== null && leftVal !== undefined) {
        const leftNode: TreeNodeLike = { val: leftVal, left: null, right: null };
        node.left = leftNode;
        queue.push(leftNode);
      }
    }

    if (i < arr.length) {
      const rightVal = arr[i++];
      if (rightVal !== null && rightVal !== undefined) {
        const rightNode: TreeNodeLike = { val: rightVal, left: null, right: null };
        node.right = rightNode;
        queue.push(rightNode);
      }
    }
  }

  return root;
}

/** Encodes a singly linked list to a plain array of values. */
export function encodeList(head: ListNodeLike | null): unknown[] {
  const out: unknown[] = [];
  let node = head;
  while (node !== null) {
    out.push(node.val);
    node = node.next;
  }
  return out;
}

/** Decodes a plain array of values into a singly linked list. */
export function decodeList(arr: ReadonlyArray<unknown>): ListNodeLike | null {
  let head: ListNodeLike | null = null;
  let tail: ListNodeLike | null = null;

  for (const val of arr) {
    const node: ListNodeLike = { val, next: null };
    if (head === null || tail === null) {
      head = node;
      tail = node;
    } else {
      tail.next = node;
      tail = node;
    }
  }

  return head;
}
