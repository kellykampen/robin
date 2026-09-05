import { execFileSync, spawn } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
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
