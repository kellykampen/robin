import { execFileSync, spawn } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createServer, Server } from "http";

const entry = resolve("src/local-cli.ts");
let root: string;
let repo: string;
let server: Server;
let url: string;
let requests: string[];
let response: string;
const clean = { summary: "No issues found.", high: [], medium: [], low: [], suggestions: [] };
function git(...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}
function run(args: string[], cwd = repo, input = "") {
  return new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn(process.execPath, ["-r", require.resolve("ts-node/register"), entry, ...args], {
      cwd, env: { ...process.env, TS_NODE_PROJECT: resolve("tsconfig.json"), LLM_BASE_URL: url, LLM_MODEL: "test-model", LLM_API_KEY: "fake-offline-key" },
    });
    child.stdin.end(input);
    let out = "", err = "";
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.on("close", code => done({ code, out, err }));
  });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "robin-cli-"));
  repo = join(root, "repo"); mkdirSync(repo);
  git("init", "-b", "main");
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "a.ts"), "const base = 1;\n");
  git("add", "."); git("commit", "-m", "base");
  requests = []; response = JSON.stringify(clean);
  server = createServer((req, res) => {
    let body = ""; req.on("data", d => body += d);
    req.on("end", () => {
      requests.push(body); res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: response } }], model: "test-model" }));
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
});
afterEach(async () => {
  await new Promise<void>(done => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});
jest.setTimeout(30000);
test("help works outside a repository", async () => {
  const result = await run(["--help"], root);
  expect(result.code).toBe(0); expect(result.out).toContain("--staged"); expect(requests).toHaveLength(0);
});
test("staged review excludes unstaged edits and produces clean JSON with severity exit status", async () => {
  writeFileSync(join(repo, "a.ts"), "const staged = 2;\n"); git("add", ".");
  writeFileSync(join(repo, "a.ts"), "const unstaged = 3;\n");
  response = JSON.stringify({ ...clean, high: [{ description: "A bug", file: "a.ts", line: 1, recommendation: "Fix it" }] });
  const result = await run(["review", "--staged", "--format", "json", "--fail-on", "high"]);
  expect(result.code).toBe(1); expect(JSON.parse(result.out).high[0].description).toBe("A bug");
  expect(requests[0]).toContain("staged = 2"); expect(requests[0]).not.toContain("unstaged = 3");
});
test("base uses merge base and includes current worktree edits when invoked from a subdirectory", async () => {
  git("checkout", "-b", "feature");
  writeFileSync(join(repo, "feature.ts"), "const feature = 1;\n"); git("add", "."); git("commit", "-m", "feature");
  git("checkout", "main"); writeFileSync(join(repo, "main.ts"), "const mainOnly = 1;\n"); git("add", "."); git("commit", "-m", "main change");
  const worktree = join(root, "worktree"); git("worktree", "add", worktree, "feature");
  writeFileSync(join(worktree, "a.ts"), "const dirty = 2;\n"); mkdirSync(join(worktree, "sub"));
  const result = await run(["review", "--base", "main", "--format", "json"], join(worktree, "sub"));
  expect(result.code).toBe(0); expect(requests[0]).toContain("feature = 1");
  expect(requests[0]).toContain("dirty = 2"); expect(requests[0]).not.toContain("mainOnly");
});
test("working tree reviews staged and unstaged changes and excludes untracked files", async () => {
  writeFileSync(join(repo, "a.ts"), "const dirty = 2;\n");
  writeFileSync(join(repo, "new.ts"), "const staged = 3;\n"); git("add", "new.ts");
  writeFileSync(join(repo, "private.txt"), "untracked-placeholder");
  const result = await run(["review", "--working-tree"]);
  expect(result.code).toBe(0); expect(result.out).toContain("No issues found.");
  expect(requests[0]).toContain("dirty = 2"); expect(requests[0]).toContain("staged = 3");
  expect(requests[0]).not.toContain("untracked-placeholder");
});
test("no changes skips model request", async () => {
  const result = await run(["review", "--format", "json"]);
  expect(result.code).toBe(0); expect(JSON.parse(result.out).status).toBe("skipped"); expect(requests).toHaveLength(0);
});
test("invalid model output fails rather than reporting a clean review", async () => {
  writeFileSync(join(repo, "a.ts"), "const dirty = 2;\n"); response = "{}";
  const result = await run(["review", "--format", "json"]);
  expect(result.code).toBe(2); expect(result.err).toContain("Invalid review response");
});
test("conflicting scope options fail before requesting a model", async () => {
  const result = await run(["review", "--staged", "--base", "main"]);
  expect(result.code).toBe(2); expect(result.err).toContain("Choose only one"); expect(requests).toHaveLength(0);
});
test("local skip paths are applied before sending the diff", async () => {
  mkdirSync(join(repo, ".github")); writeFileSync(join(repo, ".github/robin.yml"), "skip-paths:\n  - a.ts\n");
  writeFileSync(join(repo, "a.ts"), "const excluded = 2;\n");
  const result = await run(["review", "--format", "json"]);
  expect(result.code).toBe(0); expect(JSON.parse(result.out).status).toBe("skipped"); expect(requests).toHaveLength(0);
});
test("dry run emits the filtered diff without contacting a model", async () => {
  writeFileSync(join(repo, "a.ts"), "const preview = 2;\n");
  const result = await run(["review", "--dry-run", "--format", "json"]);
  expect(result.code).toBe(0); expect(JSON.parse(result.out).diff).toContain("preview = 2");
  expect(JSON.parse(result.out).status).toBe("preview"); expect(requests).toHaveLength(0);
});
test("oversized diffs fail before requesting a model", async () => {
  writeFileSync(join(repo, "a.ts"), "const large = 2;\n");
  const result = await run(["review", "--max-diff-size", "10"]);
  expect(result.code).toBe(2); expect(result.err).toContain("Nothing sent"); expect(requests).toHaveLength(0);
});
test("external Git diff drivers are never executed", async () => {
  writeFileSync(join(repo, "a.ts"), "const dirty = 2;\n");
  git("config", "diff.external", "/does-not-exist/robin-test-driver");
  const result = await run(["review"]);
  expect(result.code).toBe(0); expect(requests[0]).toContain("dirty = 2");
});
test("review instructions are loaded relative to worktree root", async () => {
  writeFileSync(join(repo, "a.ts"), "const dirty = 2;\n");
  writeFileSync(join(repo, "review.md"), "Check lifecycle cleanup carefully.");
  const result = await run(["review", "--instructions", "review.md"]);
  expect(result.code).toBe(0); expect(requests[0]).toContain("Check lifecycle cleanup carefully.");
});

test("explicit head reviews committed content and excludes dirty edits", async () => {
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "a.ts"), "const committed = 2;\n"); git("add", "."); git("commit", "-m", "change");
  writeFileSync(join(repo, "a.ts"), "const unrelatedDirty = 3;\n");
  const result = await run(["review", "--base", base, "--head", "HEAD"]);
  expect(result.code).toBe(0); expect(requests[0]).toContain("committed = 2"); expect(requests[0]).not.toContain("unrelatedDirty");
});
test("pre-push reviews the supplied ref rather than the checked out branch and blocks high findings", async () => {
  const base = git("rev-parse", "HEAD").trim();
  git("checkout", "-b", "feature"); writeFileSync(join(repo, "a.ts"), "const pushed = 2;\n");
  git("add", "."); git("commit", "-m", "change"); const head = git("rev-parse", "HEAD").trim(); git("checkout", "main");
  response = JSON.stringify({ ...clean, high: [{ description: "A bug" }] });
  const result = await run(["pre-push", "origin"], repo, `refs/heads/feature ${head} refs/heads/feature ${base}\n`);
  expect(result.code).toBe(1); expect(requests[0]).toContain("pushed = 2");
});
test("new branch pushes use the remote default branch", async () => {
  git("update-ref", "refs/remotes/origin/main", "HEAD"); git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  writeFileSync(join(repo, "a.ts"), "const newBranch = 2;\n"); git("add", "."); git("commit", "-m", "change");
  const head = git("rev-parse", "HEAD").trim();
  const result = await run(["pre-push", "origin"], repo, `refs/heads/main ${head} refs/heads/new ${"0".repeat(40)}\n`);
  expect(result.code).toBe(0); expect(requests[0]).toContain("newBranch = 2");
});
test("pre-push skips deletion, tags and empty pushes", async () => {
  const head = git("rev-parse", "HEAD").trim();
  const result = await run(["pre-push", "origin"], repo, `(delete) ${"0".repeat(40)} refs/heads/old ${head}\nrefs/tags/v1 ${head} refs/tags/v1 ${"0".repeat(40)}\n`);
  expect(result.code).toBe(0); expect(requests).toHaveLength(0);
  expect((await run(["pre-push", "origin"])).code).toBe(0);
});


describe("published rebases", () => {
  /** Publish the fixture main branch and advertise it as the bare remote default. */
  function publishDefault() {
    const remote = join(root, "remote.git");
    git("init", "--bare", remote);
    git("remote", "add", "origin", remote);
    git("push", "origin", "main");
    execFileSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    return remote;
  }
  /** Commit a fixture file and return its immutable revision. */
  function commitFile(name: string, contents: string) {
    writeFileSync(join(repo, name), contents); git("add", name); git("commit", "-m", name);
    return git("rev-parse", "HEAD").trim();
  }
  /** Rebase a published topic over oversized accepted trunk, then add an owned repair and deletion. */
  function rebasedTopic() {
    publishDefault();
    git("checkout", "-b", "topic");
    commitFile("own.ts", "const own = 'must remain reviewed';\n");
    const old = commitFile("deleted.ts", "const removedByRepair = 1;\n");
    git("push", "origin", "topic");
    git("checkout", "main");
    const trunk = commitFile("accepted.ts", "const inherited = 'accepted';\n".repeat(2200));
    git("push", "origin", "main");
    git("checkout", "topic"); git("rebase", "main");
    commitFile("own.ts", "const own = 'new repair must remain reviewed';\n");
    git("rm", "deleted.ts"); git("commit", "-m", "remove owned file");
    return { old, trunk, head: git("rev-parse", "HEAD").trim() };
  }
  test("rebased published topic excludes accepted trunk while retaining owning changes and repair", async () => {
    const { old, head } = rebasedTopic();
    const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(0); expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("new repair must remain reviewed");
    expect(requests[0]).not.toContain("inherited");
  });
  test("untrusted local default and ROBIN_BASE cannot hide new owning changes", async () => {
    const { old, head } = rebasedTopic();
    git("update-ref", "refs/remotes/origin/main", head);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const previous = process.env.ROBIN_BASE; process.env.ROBIN_BASE = head;
    try {
      const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
      expect(result.code).toBe(0); expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("new repair must remain reviewed");
    } finally {
      if (previous === undefined) delete process.env.ROBIN_BASE; else process.env.ROBIN_BASE = previous;
    }
  });
  test("ordinary fast-forward retains its delta without requiring the remote", async () => {
    const old = git("rev-parse", "HEAD").trim();
    const head = commitFile("own.ts", "const incrementalOnly = 1;\n");
    const result = await run(["pre-push", "missing-remote"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(0); expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("incrementalOnly");
  });
  test("divergent default-branch push retains its own changed source", async () => {
    const { old, head } = rebasedTopic();
    git("push", "--force", "origin", `${old}:main`);
    const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/main ${old}\n`);
    expect(result.code).toBe(2); expect(requests).toHaveLength(0);
    expect(result.err).toContain("above limit 50000");
  });
  test("every multi-ref baseline is checked before any model I/O", async () => {
    const { old, head, trunk } = rebasedTopic();
    const result = await run(["pre-push", "missing-remote"], repo,
      `refs/heads/topic ${head} refs/heads/one ${trunk}\nrefs/heads/topic ${head} refs/heads/two ${old}\n`);
    expect(result.code).toBe(2); expect(requests).toHaveLength(0);
  });
  test("force-with-lease topic input retains deletions and ignores unrelated dirty content", async () => {
    const { old } = rebasedTopic();
    git("rm", "a.ts"); git("commit", "-m", "delete baseline source");
    const head = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "own.ts"), "private-uncommitted-placeholder\n");
    const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(0); expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("-const base = 1;");
    expect(requests[0]).toContain("new repair must remain reviewed");
    expect(requests[0]).not.toContain("private-uncommitted-placeholder");
    git("push", `--force-with-lease=refs/heads/topic:${old}`, "origin", "topic");
    expect(git("ls-remote", "origin", "refs/heads/topic")).toContain(head);
  });
  test("divergent topic with an unknown remote fails closed", async () => {
    const { old, head } = rebasedTopic();
    const result = await run(["pre-push", "missing-remote"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(2); expect(requests).toHaveLength(0);
  });
  test("ambiguous accepted ancestry fails closed", async () => {
    publishDefault();
    const base = git("rev-parse", "HEAD").trim();
    const tree = git("rev-parse", "HEAD^{tree}").trim();
    const left = git("commit-tree", tree, "-p", base, "-m", "left").trim();
    const right = git("commit-tree", tree, "-p", base, "-m", "right").trim();
    const accepted = git("commit-tree", tree, "-p", left, "-p", right, "-m", "accepted merge").trim();
    const head = git("commit-tree", tree, "-p", right, "-p", left, "-m", "topic merge").trim();
    const old = git("commit-tree", tree, "-p", base, "-m", "old published topic").trim();
    git("push", "origin", `${accepted}:main`);
    const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(2); expect(requests).toHaveLength(0);
    expect(result.err).toContain("unique review base");
  });
  test("unknown remote default HEAD fails closed", async () => {
    const { old, head } = rebasedTopic();
    execFileSync("git", ["--git-dir", join(root, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/missing"]);
    const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(2); expect(requests).toHaveLength(0);
  });
  test("unrelated accepted history and missing previous remote objects fail closed", async () => {
    const { old, head } = rebasedTopic();
    const unrelated = git("commit-tree", git("rev-parse", "HEAD^{tree}").trim(), "-m", "unrelated root").trim();
    git("push", "--force", "origin", `${unrelated}:main`);
    for (const previous of [old, "f".repeat(40)]) {
      const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/topic ${previous}\n`);
      expect(result.code).toBe(2); expect(requests).toHaveLength(0);
    }
  });
  test("multi-ref proposed trunk cannot become a topic self-baseline", async () => {
    const { old, head, trunk } = rebasedTopic();
    const result = await run(["pre-push", "origin"], repo,
      `refs/heads/topic ${head} refs/heads/main ${trunk}\nrefs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(0); expect(requests).toHaveLength(2);
    for (const request of requests) expect(request).toContain("new repair must remain reviewed");
  });
  test("unrelated index conflict cannot omit the immutable pushed source", async () => {
    const { old, head } = rebasedTopic();
    const blob = git("rev-parse", "HEAD:a.ts").trim();
    execFileSync("git", ["update-index", "--index-info"], { cwd: repo, input:
      `0 ${"0".repeat(40)}\ta.ts\n100644 ${blob} 1\ta.ts\n100644 ${blob} 2\ta.ts\n100644 ${blob} 3\ta.ts\n` });
    expect(git("ls-files", "-u")).not.toBe("");
    const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(0); expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("new repair must remain reviewed");
  });
  test("push URL and explicit Git destination override cannot use a different fetch remote", async () => {
    const { old, head } = rebasedTopic();
    const acceptedServer = join(root, "remote.git");
    const misleadingServer = join(root, "misleading.git");
    git("init", "--bare", misleadingServer);
    git("push", misleadingServer, `${head}:refs/heads/main`);
    execFileSync("git", ["--git-dir", misleadingServer, "symbolic-ref", "HEAD", "refs/heads/main"]);
    git("remote", "set-url", "origin", misleadingServer);
    git("remote", "set-url", "--push", "origin", acceptedServer);
    const input = `refs/heads/topic ${head} refs/heads/topic ${old}\n`;
    expect((await run(["pre-push", "origin"], repo, input)).code).toBe(0);
    expect(requests).toHaveLength(1); expect(requests[0]).toContain("new repair must remain reviewed");
    git("remote", "set-url", "--push", "origin", misleadingServer);
    expect((await run(["pre-push", "origin", acceptedServer], repo, input)).code).toBe(0);
    expect(requests).toHaveLength(2); expect(requests[1]).toContain("new repair must remain reviewed");
  });
  test("a missing immutable head in any update blocks before model I/O", async () => {
    const old = git("rev-parse", "HEAD").trim();
    const head = commitFile("own.ts", "const validFirstRef = 1;\n");
    git("update-ref", "refs/remotes/origin/main", old);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const result = await run(["pre-push", "origin"], repo,
      `refs/heads/topic ${head} refs/heads/one ${old}\nrefs/heads/missing ${"f".repeat(40)} refs/heads/two ${"0".repeat(40)}\n`);
    expect(result.code).toBe(2); expect(requests).toHaveLength(0);
  });
  test("multiple divergent refs share one immutable advertised default snapshot", async () => {
    const { old, head } = rebasedTopic();
    const bin = join(root, "bin"); mkdirSync(bin);
    const log = join(root, "lookups");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), '#!/bin/sh\nif [ "$1" = "ls-remote" ]; then printf "lookup\\n" >> "$SCOPE_LOOKUP_LOG"; fi\nexec "$SCOPE_REAL_GIT" "$@"\n', { mode: 0o755 });
    const previous = { PATH: process.env.PATH, SCOPE_LOOKUP_LOG: process.env.SCOPE_LOOKUP_LOG, SCOPE_REAL_GIT: process.env.SCOPE_REAL_GIT };
    process.env.PATH = `${bin}:${process.env.PATH}`; process.env.SCOPE_LOOKUP_LOG = log; process.env.SCOPE_REAL_GIT = realGit;
    try {
      const result = await run(["pre-push", "origin"], repo,
        `refs/heads/topic ${head} refs/heads/one ${old}\nrefs/heads/topic ${head} refs/heads/two ${old}\n`);
      expect(result.code).toBe(0); expect(requests).toHaveLength(2);
      expect(readFileSync(log, "utf8")).toBe("lookup\n");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  test("direct invocation with multiple push destinations fails before model I/O", async () => {
    const { old, head } = rebasedTopic();
    git("remote", "set-url", "--add", "--push", "origin", join(root, "remote.git"));
    git("remote", "set-url", "--add", "--push", "origin", join(root, "other-destination.git"));
    const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(2); expect(requests).toHaveLength(0);
  });
  test("missing advertised trunk object fails before model I/O", async () => {
    const { old, head } = rebasedTopic();
    const other = join(root, "other"); git("clone", join(root, "remote.git"), other);
    execFileSync("git", ["-C", other, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", other, "config", "user.email", "test@example.invalid"]);
    writeFileSync(join(other, "unknown.ts"), "unknown\n");
    for (const args of [["add", "."], ["commit", "-m", "new remote only"], ["push", "origin", "main"]]) execFileSync("git", ["-C", other, ...args]);
    const result = await run(["pre-push", "origin"], repo, `refs/heads/topic ${head} refs/heads/topic ${old}\n`);
    expect(result.code).toBe(2); expect(requests).toHaveLength(0);
    expect(result.err).toMatch(/advertised|Fetch|object/);
  });
});
