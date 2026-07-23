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
 *     `<<<ALGOLIFT_RESULT>>>` sentinel line followed by one JSON object, identical in shape to the
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
import { parseParamType, type ParamTypeAst, type Signature } from "@algolift/shared";

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

/** The C++ identifier bits (structs, templates, comparators, the per-test driver) that never vary
 * with the problem's signature — emitted verbatim into every generated `main.cpp`. Kept as one
 * template string (rather than N small ones) so the generated file reads as a single coherent
 * translation unit, the same way a developer would hand-write it. */
const STATIC_PRELUDE = `
// ---------------------------------------------------------------------------
// LeetCode-style structures, injected before "solution.cpp" is included so user code can
// reference TreeNode / ListNode without declaring them itself — mirrors runner.py's
// module.TreeNode / module.ListNode injection.
// ---------------------------------------------------------------------------
struct TreeNode {
    long long val;
    TreeNode* left;
    TreeNode* right;
    TreeNode() : val(0), left(nullptr), right(nullptr) {}
    explicit TreeNode(long long x) : val(x), left(nullptr), right(nullptr) {}
    TreeNode(long long x, TreeNode* l, TreeNode* r) : val(x), left(l), right(r) {}
};

struct ListNode {
    long long val;
    ListNode* next;
    ListNode() : val(0), next(nullptr) {}
    explicit ListNode(long long x) : val(x), next(nullptr) {}
    ListNode(long long x, ListNode* n) : val(x), next(n) {}
};
`;

const STATIC_HARNESS = `
// ---------------------------------------------------------------------------
// Tree / linked-list codecs — byte-for-byte the same LeetCode-style encodings runner.py's
// decode_tree/encode_tree/decode_list/encode_list use: level-order array with null holes
// (trailing nulls trimmed on encode) for TreeNode; a plain array for ListNode.
// ---------------------------------------------------------------------------
TreeNode* decode_tree(const json& j) {
    if (j.is_null() || j.empty()) return nullptr;
    auto it = j.begin();
    if (it->is_null()) return nullptr;
    TreeNode* root = new TreeNode(it->get<long long>());
    std::queue<TreeNode*> q;
    q.push(root);
    ++it;
    while (!q.empty() && it != j.end()) {
        TreeNode* node = q.front();
        q.pop();
        if (it != j.end()) {
            if (!it->is_null()) {
                node->left = new TreeNode(it->get<long long>());
                q.push(node->left);
            }
            ++it;
        }
        if (it != j.end()) {
            if (!it->is_null()) {
                node->right = new TreeNode(it->get<long long>());
                q.push(node->right);
            }
            ++it;
        }
    }
    return root;
}

json encode_tree(TreeNode* root) {
    json out = json::array();
    if (root == nullptr) return out;
    std::queue<TreeNode*> q;
    q.push(root);
    while (!q.empty()) {
        TreeNode* node = q.front();
        q.pop();
        if (node == nullptr) {
            out.push_back(nullptr);
            continue;
        }
        out.push_back(node->val);
        q.push(node->left);
        q.push(node->right);
    }
    while (!out.empty() && out.back().is_null()) {
        out.erase(out.size() - 1);
    }
    return out;
}

ListNode* decode_list(const json& j) {
    if (j.empty()) return nullptr;
    ListNode* head = new ListNode(j.at(0).get<long long>());
    ListNode* cur = head;
    for (size_t i = 1; i < j.size(); ++i) {
        cur->next = new ListNode(j.at(i).get<long long>());
        cur = cur->next;
    }
    return head;
}

json encode_list(ListNode* head) {
    json out = json::array();
    ListNode* cur = head;
    long long seen = 0;
    while (cur != nullptr) {
        out.push_back(cur->val);
        cur = cur->next;
        if (++seen > 2000000) {
            throw std::runtime_error("linked list output is too long (possible cycle)");
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Generic decode/encode via a Codec<T> struct-template (C++ has no partial specialization for
// function templates, so a struct is the standard way to get "one implementation per shape of T",
// which is what lets list[list[int]] etc. codegen down to a single generic Codec<std::vector<...>>
// instead of bespoke per-depth code).
// ---------------------------------------------------------------------------
template <typename T>
struct Codec;

template <>
struct Codec<long long> {
    static long long decode(const json& j) { return j.get<long long>(); }
    static json encode(long long v) { return json(v); }
};

template <>
struct Codec<double> {
    static double decode(const json& j) { return j.get<double>(); }
    static json encode(double v) { return json(v); }
};

template <>
struct Codec<bool> {
    static bool decode(const json& j) { return j.get<bool>(); }
    static json encode(bool v) { return json(v); }
};

template <>
struct Codec<std::string> {
    static std::string decode(const json& j) { return j.get<std::string>(); }
    static json encode(const std::string& v) { return json(v); }
};

template <typename T>
struct Codec<std::vector<T>> {
    static std::vector<T> decode(const json& j) {
        std::vector<T> out;
        out.reserve(j.size());
        for (const auto& item : j) {
            out.push_back(Codec<T>::decode(item));
        }
        return out;
    }
    static json encode(const std::vector<T>& v) {
        json out = json::array();
        for (const auto& item : v) {
            out.push_back(Codec<T>::encode(item));
        }
        return out;
    }
};

template <>
struct Codec<TreeNode*> {
    static TreeNode* decode(const json& j) { return decode_tree(j); }
    static json encode(TreeNode* v) { return encode_tree(v); }
};

template <>
struct Codec<ListNode*> {
    static ListNode* decode(const json& j) { return decode_list(j); }
    static json encode(ListNode* v) { return encode_list(v); }
};

// ---------------------------------------------------------------------------
// Comparators — operate on generic json trees (never on the problem's static C++ types), so this
// code is identical for every signature. Mirrors runner.py's exact_equal / float_tol_equal /
// unordered_equal exactly, including the bool-vs-number distinction (True != 1).
// ---------------------------------------------------------------------------
bool is_number_not_bool(const json& j) { return j.is_number() && !j.is_boolean(); }

bool exact_equal(const json& a, const json& b) {
    if (a.is_array() && b.is_array()) {
        if (a.size() != b.size()) return false;
        for (size_t i = 0; i < a.size(); ++i) {
            if (!exact_equal(a[i], b[i])) return false;
        }
        return true;
    }
    if (a.is_object() && b.is_object()) {
        if (a.size() != b.size()) return false;
        for (auto it = a.begin(); it != a.end(); ++it) {
            if (!b.contains(it.key())) return false;
            if (!exact_equal(it.value(), b.at(it.key()))) return false;
        }
        return true;
    }
    if (a.is_boolean() != b.is_boolean()) return false;
    if (is_number_not_bool(a) && is_number_not_bool(b)) {
        return a.get<double>() == b.get<double>();
    }
    return a == b;
}

bool float_tol_equal(const json& a, const json& b, double tol_abs, double tol_rel) {
    if (a.is_array() && b.is_array()) {
        if (a.size() != b.size()) return false;
        for (size_t i = 0; i < a.size(); ++i) {
            if (!float_tol_equal(a[i], b[i], tol_abs, tol_rel)) return false;
        }
        return true;
    }
    if (is_number_not_bool(a) && is_number_not_bool(b)) {
        double x = a.get<double>();
        double y = b.get<double>();
        return std::fabs(x - y) <= std::max(tol_abs, tol_rel * std::max(std::fabs(x), std::fabs(y)));
    }
    return exact_equal(a, b);
}

json normalize_for_unordered(const json& x) {
    if (!x.is_array()) return x;
    std::vector<json> normalized;
    normalized.reserve(x.size());
    for (const auto& item : x) {
        normalized.push_back(normalize_for_unordered(item));
    }
    std::sort(normalized.begin(), normalized.end(), [](const json& a, const json& b) {
        return a.dump() < b.dump();
    });
    json out = json::array();
    for (auto& item : normalized) out.push_back(std::move(item));
    return out;
}

bool unordered_equal(const json& a, const json& b) {
    if (a.is_array() && b.is_array()) {
        if (a.size() != b.size()) return false;
        std::vector<std::string> ka, kb;
        ka.reserve(a.size());
        kb.reserve(b.size());
        for (const auto& item : a) ka.push_back(normalize_for_unordered(item).dump());
        for (const auto& item : b) kb.push_back(normalize_for_unordered(item).dump());
        std::sort(ka.begin(), ka.end());
        std::sort(kb.begin(), kb.end());
        return ka == kb;
    }
    return exact_equal(a, b);
}

bool compare_values(const json& output, const json& expected, const json& comparator) {
    std::string kind = comparator.value("kind", std::string("exact"));
    if (kind == "exact") return exact_equal(output, expected);
    if (kind == "float_tol") {
        double tol = comparator.value("tol", 1e-6);
        return float_tol_equal(output, expected, tol, tol);
    }
    if (kind == "unordered") return unordered_equal(output, expected);
    // checker_py is rejected host-side (executeCpp) before any C++ bundle is ever built or run —
    // reaching here would mean that guard was bypassed. Defense in depth only.
    throw std::runtime_error("unsupported comparator kind for the C++ harness: " + kind);
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------
const std::string RESULT_SENTINEL = "<<<ALGOLIFT_RESULT>>>";
constexpr size_t MAX_TEST_STDOUT_BYTES = 4 * 1024;
constexpr size_t MAX_OUTPUT_JSON_BYTES = 2 * 1024;
constexpr int DEFAULT_PER_TEST_TIMEOUT_MS = 5000;
// Generous C stack for each test's worker thread, matching runner.py's THREAD_STACK_SIZE —
// mitigates (does not guarantee-fix; native stack overflow is unrecoverable) deep recursion.
constexpr size_t THREAD_STACK_SIZE = 256 * 1024 * 1024;

std::string scrub_paths(const std::string& text) {
    std::string result = text;
    for (const char* needle : {"/bundle/", "/work/"}) {
        size_t needle_len = std::strlen(needle);
        size_t pos;
        while ((pos = result.find(needle)) != std::string::npos) {
            result.erase(pos, needle_len);
        }
    }
    return result;
}

std::string replace_all(std::string text, const std::string& from, const std::string& to) {
    if (from.empty()) return text;
    size_t pos = 0;
    while ((pos = text.find(from, pos)) != std::string::npos) {
        text.replace(pos, from.size(), to);
        pos += to.size();
    }
    return text;
}

std::string demangle(const char* mangled) {
    int status = 0;
    char* out = abi::__cxa_demangle(mangled, nullptr, nullptr, &status);
    std::string result = (status == 0 && out != nullptr) ? std::string(out) : std::string(mangled);
    std::free(out);
    return result;
}

std::string truncate_utf8(const std::string& s, size_t max_bytes) {
    if (s.size() <= max_bytes) return s;
    return s.substr(0, max_bytes) + "...[truncated]";
}

long long current_rss_kb() {
    struct rusage usage {};
    getrusage(RUSAGE_SELF, &usage);
    // Linux: ru_maxrss is already in KB — same units, same call shape as runner.py's
    // resource.getrusage(RUSAGE_SELF).ru_maxrss, for parity between the two harnesses.
    return static_cast<long long>(usage.ru_maxrss);
}

/** A stdout-shaped black hole, swapped in permanently right before the final sentinel emission —
 * mirrors runner.py's _NullWriter: any stray thread from a timed-out test that eventually gets
 * scheduled and writes to std::cout after this point can never land on real stdout again. */
class NullStreamBuf : public std::streambuf {
protected:
    int overflow(int c) override { return c; }
};

/** The ONLY function allowed to touch the real stdout FILE* after program start — deliberately
 * bypasses std::cout (which may already be permanently blackholed by the time this runs) by
 * writing through C stdio directly, which is unaffected by std::cout's rdbuf reassignment. */
void emit_result(const json& payload) {
    static NullStreamBuf null_buf;
    std::cout.rdbuf(&null_buf);
    std::string body = payload.dump();
    // Redact any literal sentinel substring embedded in the payload itself (e.g. captured stdout
    // containing a spoofed result block) so the line written immediately below is guaranteed to
    // be the only true occurrence in the whole stream — same defense as runner.py's emit().
    body = replace_all(body, RESULT_SENTINEL, "<<<ALGOLIFT_RESULT (redacted, embedded in output)>>>");
    std::fputs(RESULT_SENTINEL.c_str(), stdout);
    std::fputc('\\n', stdout);
    std::fputs(body.c_str(), stdout);
    std::fputc('\\n', stdout);
    std::fflush(stdout);
}

json load_json_file(const std::string& path) {
    std::ifstream in(path);
    if (!in) {
        throw std::runtime_error("failed to open " + path);
    }
    json j;
    in >> j;
    return j;
}

struct TestOutcome {
    std::atomic<bool> done{false};
    std::string status; // "ok" | "error" — set by the worker thread
    std::string error;
    json output;
};

struct ThreadArgs {
    std::shared_ptr<json> args;
    std::shared_ptr<TestOutcome> outcome;
    std::shared_ptr<std::ostringstream> capture;
};

/**
 * Runs entirely inside the detached/joinable worker thread. Deliberately does NOT touch
 * std::cout's rdbuf itself (that happens only from the main thread, around thread creation/wait —
 * see run_one_test below) so a thread that outlives its timeout and keeps running never races a
 * *later* test's redirection any more than runner.py's identical daemon-thread design already
 * accepts; see emit_result's permanent blackout for the property that actually matters (the final
 * sentinel can never be corrupted).
 */
void* test_thread_entry(void* raw) {
    std::unique_ptr<ThreadArgs> targs(static_cast<ThreadArgs*>(raw));
    try {
        json result = call_solution(*targs->args);
        targs->outcome->output = std::move(result);
        targs->outcome->status = "ok";
    } catch (const std::exception& e) {
        targs->outcome->status = "error";
        targs->outcome->error = demangle(typeid(e).name()) + ": " + std::string(e.what());
    } catch (...) {
        targs->outcome->status = "error";
        targs->outcome->error = "unrecognized C++ exception (not derived from std::exception)";
    }
    targs->outcome->done.store(true);
    return nullptr;
}

json run_one_test(int index, const json& test, int per_test_timeout_ms, const json& comparator) {
    json args = test.contains("args") ? test.at("args") : json::array();
    bool has_expected = test.contains("expected");

    auto outcome = std::make_shared<TestOutcome>();
    auto capture = std::make_shared<std::ostringstream>();
    auto args_copy = std::make_shared<json>(args);

    auto* targs = new ThreadArgs{args_copy, outcome, capture};

    auto started = std::chrono::steady_clock::now();

    std::streambuf* real_buf = std::cout.rdbuf();
    std::cout.rdbuf(capture->rdbuf());

    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, THREAD_STACK_SIZE);
    pthread_t tid{};
    pthread_create(&tid, &attr, test_thread_entry, targs);
    pthread_attr_destroy(&attr);

    bool timed_out = false;
    while (!outcome->done.load()) {
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started)
            .count();
        if (elapsed > per_test_timeout_ms) {
            timed_out = true;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (timed_out) {
        pthread_detach(tid);
    } else {
        pthread_join(tid, nullptr);
    }

    std::cout.rdbuf(real_buf);

    double elapsed_ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();

    json result;
    result["index"] = index;

    if (timed_out) {
        result["status"] = "timeout";
        result["time_ms"] = elapsed_ms;
        result["memory_kb"] = current_rss_kb();
        result["error"] = "time limit exceeded";
        return result;
    }

    std::string captured = truncate_utf8(capture->str(), MAX_TEST_STDOUT_BYTES);

    if (outcome->status == "error") {
        result["status"] = "error";
        result["time_ms"] = elapsed_ms;
        result["memory_kb"] = current_rss_kb();
        if (!captured.empty()) result["stdout"] = captured;
        result["error"] = scrub_paths(outcome->error);
        return result;
    }

    result["time_ms"] = elapsed_ms;
    result["memory_kb"] = current_rss_kb();
    if (!captured.empty()) result["stdout"] = captured;

    if (!has_expected) {
        // CONTRACTS §4.5: no expected value to grade against.
        result["status"] = "completed";
    } else {
        bool is_pass;
        try {
            is_pass = compare_values(outcome->output, test.at("expected"), comparator);
        } catch (const std::exception& e) {
            result["status"] = "error";
            result["error"] = scrub_paths(std::string("comparator failed: ") + e.what());
            return result;
        }
        result["status"] = is_pass ? "passed" : "failed";
    }

    // 'expected' is NEVER emitted — only the actual (possibly truncated) output.
    std::string out_json = outcome->output.dump();
    if (out_json.size() > MAX_OUTPUT_JSON_BYTES) {
        result["output"] = nullptr;
        result["output_truncated"] = true;
    } else {
        result["output"] = outcome->output;
    }

    return result;
}

void run_harness(const std::string& bundle_dir) {
    json tests;
    json comparator;
    json config;
    try {
        tests = load_json_file(bundle_dir + "/tests.json");
    } catch (const std::exception& e) {
        emit_result(json{{"ok", false},
                          {"error_kind", "bundle_error"},
                          {"error", std::string("failed to read bundle: ") + e.what()},
                          {"tests", json::array()}});
        return;
    }
    try {
        comparator = load_json_file(bundle_dir + "/comparator.json");
    } catch (...) {
        comparator = json::object({{"kind", "exact"}});
    }
    try {
        config = load_json_file(bundle_dir + "/config.json");
    } catch (...) {
        config = json::object();
    }

    int per_test_timeout_ms = config.value("per_test_timeout_ms", DEFAULT_PER_TEST_TIMEOUT_MS);

    json results = json::array();
    for (size_t i = 0; i < tests.size(); ++i) {
        results.push_back(run_one_test(static_cast<int>(i), tests.at(i), per_test_timeout_ms, comparator));
    }

    emit_result(json{{"ok", true}, {"tests", results}});
}
`;

/**
 * Generates the full `main.cpp` translation unit for a given problem `Signature`. Deterministic —
 * the same `Signature` always produces byte-identical output, which is what makes it snapshottable
 * in unit tests without Docker.
 */
export function generateMainCpp(signature: Signature): string {
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
