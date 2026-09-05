import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { parseArgs } from "util";
import { startSpinner } from "./spinner";
import { prePush } from "./pre-push";
import { loadLocalEnv } from "./local-env";
import { LLMClient } from "./llm-client";
import { ReviewParser } from "./review-parser";
import { filterDiff } from "./diff-filter";
import { annotateDiffWithLineNumbers } from "./diff-annotate";
import { getReviewPrompt } from "./prompts/review-prompts";
import { DEFAULT_CONFIG_FILE, parseRepoConfigYaml } from "./repo-config";

const help = `Usage: robin review [options]

Review local changes from any directory in a Git repository or worktree.
No GitHub token or pull request required. Only the configured model is contacted.

  --base <ref>            Branch changes since merge base, plus tracked local edits
  --head <ref>            Review committed content at ref (requires --base)
  --staged                Only changes staged for the next commit
  --working-tree          Staged and unstaged tracked changes against HEAD (default)
  --format <format>       text, markdown, or json (default: text)
  --fail-on <severity>    high, medium, low, or none (default: none)
  --model <id>            Override LLM_MODEL
  --base-url <url>        Override LLM_BASE_URL (OpenAI-compatible API)
  --instructions <file>   Read reviewer instructions, relative to repository root
  --max-diff-size <n>     Maximum diff characters; larger diffs fail without sending
  --dry-run              Print the filtered diff without contacting a model
  --help                 Show this help

Credentials: ~/.config/robin/.env, overridden by shell LLM_* variables and flags.
LLM_API_KEY is not required for localhost APIs.
Config: .github/robin.yml in the current worktree (skip-paths, max-diff-size).
Untracked files are excluded. Stage new files to include them.
Exit codes: 0 completed/skipped, 1 severity threshold reached, 2 review failed.
`;

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`Git command failed: git ${args.join(" ")}. Check the repository and refs.`);
  }
}

function validateResponse(content: string): string {
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj.summary !== "string" || !obj.summary.trim()) throw new Error();
    for (const key of ["high", "medium", "low", "suggestions"]) {
      if (!Array.isArray(obj[key]) || obj[key].some((f: Record<string, unknown>) =>
        !f || typeof f.description !== "string" || !f.description.trim()
        || (f.file !== undefined && typeof f.file !== "string")
        || (f.line != null && (!Number.isInteger(f.line) || Number(f.line) < 1)))) throw new Error();
    }
    return text;
  } catch {
    throw new Error("Invalid review response: expected summary and high/medium/low/suggestions arrays. Review incomplete.");
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "pre-push") {
    process.exitCode = await prePush(process.argv[3] || "origin");
    return;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" }, "dry-run": { type: "boolean" }, base: { type: "string" }, head: { type: "string" }, staged: { type: "boolean" },
      "working-tree": { type: "boolean" }, format: { type: "string", default: "text" },
      "fail-on": { type: "string", default: "none" }, model: { type: "string" },
      "base-url": { type: "string" }, instructions: { type: "string" }, "max-diff-size": { type: "string" },
    },
  });
  if (values.help) { process.stdout.write(help); return; }
  if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== "review")) {
    throw new Error("Expected 'robin review'. Use --help for options.");
  }
  if ([values.base !== undefined, values.staged, values["working-tree"]].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --base, --staged, or --working-tree.");
  }
  if (!["text", "markdown", "json"].includes(values.format!)) throw new Error("Invalid --format.");
  const threshold = values["fail-on"]!;
  if (!["none", "high", "medium", "low"].includes(threshold)) throw new Error("Invalid --fail-on severity.");
  if (values.head !== undefined && values.base === undefined) throw new Error("--head requires --base.");
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  let config = {} as ReturnType<typeof parseRepoConfigYaml>;
  try { config = parseRepoConfigYaml(readFileSync(join(root, DEFAULT_CONFIG_FILE), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const limit = values["max-diff-size"] === undefined ? config.maxDiffSize ?? 50000 : Number(values["max-diff-size"]);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("max-diff-size must be a positive integer.");
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=all"];
  if (values.base !== undefined) {
    const base = git(root, ["rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`]).trim();
    const head = values.head === undefined ? "HEAD" : git(root, ["rev-parse", "--verify", "--end-of-options", `${values.head}^{commit}`]).trim();
    diffArgs.push(git(root, ["merge-base", head, base]).trim());
    if (values.head !== undefined) diffArgs.push(head);
  } else if (values.staged) {
    diffArgs.push("--cached");
  } else {
    diffArgs.push("HEAD");
  }
  // Detect conflicts before obtaining a diff that could otherwise omit conflicted hunks.
  if (values.head === undefined && git(root, ["ls-files", "-u"]).trim()) throw new Error("Resolve merge conflicts before reviewing.");
  const { filtered: diff, removedFiles } = filterDiff(git(root, [...diffArgs, "--"]), config.skipPaths);
  if (!diff.trim()) {
    process.stdout.write(values.format === "json"
      ? JSON.stringify({ status: "skipped", summary: "No reviewable changes.", removedFiles }) + "\n"
      : "No reviewable changes.\n");
    return;
  }
  if (diff.length > limit) throw new Error(`Diff is ${diff.length} characters, above limit ${limit}. Narrow the scope or increase --max-diff-size. Nothing sent.`);
  if (values["dry-run"]) {
    process.stdout.write(values.format === "json"
      ? JSON.stringify({ status: "preview", diff, removedFiles }, null, 2) + "\n" : diff);
    return;
  }
  const env = loadLocalEnv();
  const baseUrl = values["base-url"] ?? env.LLM_BASE_URL;
  const model = values.model ?? env.LLM_MODEL;
  if (!baseUrl || !model) throw new Error("Set LLM_BASE_URL and LLM_MODEL, or use --base-url and --model.");
  const endpoint = new URL(baseUrl);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Use an HTTP(S) base URL without embedded credentials.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  const key = env.LLM_API_KEY;
  if (!key && !local) throw new Error("Set LLM_API_KEY for a remote model provider.");
  const instructions = values.instructions ? readFileSync(resolve(root, values.instructions), "utf8") : "";
  // Upstream components accept a logger so machine-readable stdout stays clean.
  // Avoid printing provider errors or URLs, which may contain credentials.
  const logger = {
    info: () => undefined,
    warning: () => process.stderr.write("Robin: model response or retry warning.\n"),
    error: () => undefined,
  };

  const client = new LLMClient(baseUrl, key || "ollama", model, undefined, undefined, undefined, undefined, undefined, logger);
  let content: string;
  const stopSpinner = startSpinner(`Reviewing ${diff.length} diff characters with ${model}`);
  try {
    content = (await client.chatCompletion(getReviewPrompt(instructions),
      "Review this diff. Each line has its NEW-file line number. Return the strict JSON object from the system prompt.\n```diff\n"
      + annotateDiffWithLineNumbers(diff) + "\n```", true)).content;
  } catch { throw new Error("Model request failed. Check provider credentials, model, and availability."); }
  finally { stopSpinner(); }
  const { rawResponse: _raw, ...review } = ReviewParser.parseDetailed(validateResponse(content), logger).findings;
  void _raw;
  if (values.format === "json") {
    process.stdout.write(JSON.stringify({ status: "completed", ...review, removedFiles }, null, 2) + "\n");
  } else {
    const lines = [review.summary, ""];
    for (const finding of [...review.high, ...review.medium, ...review.low, ...review.suggestions]) {
      lines.push(`[${finding.severity.toUpperCase()}] ${finding.file || "General"}${finding.line ? `:${finding.line}` : ""}`,
        finding.description, finding.recommendation, "");
    }
    process.stdout.write(lines.join("\n") + "\n");
  }
  if (threshold !== "none" && (review.high.length > 0
    || (threshold !== "high" && review.medium.length > 0)
    || (threshold === "low" && review.low.length > 0))) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`Robin: ${error instanceof Error ? error.message : "Review failed"}\n`);
  process.exitCode = 2;
});
