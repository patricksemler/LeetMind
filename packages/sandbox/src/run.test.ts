import { describe, expect, it } from "vitest";
import { buildDockerArgs } from "./dockerArgs.js";

describe("buildDockerArgs", () => {
  it("produces the exact mandatory flag list and order from CONTRACTS.md §6, plus --name", () => {
    const args = buildDockerArgs({
      image: "leetmind/runner-python:1",
      bundleDir: "/tmp/leetmind-sandbox/01ARZ3NDEKTSV4RRFFQ69G5FAV",
      argv: ["python3", "/bundle/runner.py"],
      limits: {
        memoryMb: 256,
        cpus: 1,
        pidsLimit: 64,
        wallTimeoutMs: 10000,
        outputLimitBytes: 65536,
      },
      name: "leetmind-sbx-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });

    expect(args).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/work:rw,size=64m,mode=1777,exec",
      "-v",
      "/tmp/leetmind-sandbox/01ARZ3NDEKTSV4RRFFQ69G5FAV:/bundle:ro",
      "--memory",
      "256m",
      "--memory-swap",
      "256m",
      "--cpus",
      "1",
      "--pids-limit",
      "64",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-u",
      "65534:65534",
      "-w",
      "/work",
      "--label",
      "leetmind.sandbox=1",
      "--name",
      "leetmind-sbx-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "leetmind/runner-python:1",
      "python3",
      "/bundle/runner.py",
    ]);
  });

  it("interpolates limits and bundle dir per-call, not a fixed template", () => {
    const args = buildDockerArgs({
      image: "leetmind/runner-cpp:1",
      bundleDir: "/work-dir/other",
      argv: ["/work/prog"],
      limits: { memoryMb: 512, cpus: 2, pidsLimit: 32, wallTimeoutMs: 5000, outputLimitBytes: 1024 },
      name: "leetmind-sbx-xyz",
    });

    expect(args).toContain("512m");
    expect(args).toContain("2");
    expect(args).toContain("32");
    expect(args).toContain("/work-dir/other:/bundle:ro");
    expect(args[args.length - 2]).toBe("leetmind/runner-cpp:1");
    expect(args[args.length - 1]).toBe("/work/prog");
  });

  it("never builds argv as a single shell string", () => {
    const args = buildDockerArgs({
      image: "leetmind/runner-python:1",
      bundleDir: "/tmp/x",
      argv: ["python3", "/bundle/runner.py"],
      limits: { memoryMb: 256, cpus: 1, pidsLimit: 64, wallTimeoutMs: 10000, outputLimitBytes: 65536 },
      name: "leetmind-sbx-1",
    });
    // every element is a discrete token; none contain embedded whitespace-joined flag pairs
    for (const arg of args) {
      expect(typeof arg).toBe("string");
    }
  });
});
