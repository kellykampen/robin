import { execFileSync, spawn, spawnSync } from "child_process";
import { readFileSync } from "fs";

/** Run a bounded Git query without exposing remote credentials in command output. */
function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 1024 * 1024,
  }).trim();
}

type RemoteDefault = { ref: string; head: string };

/** Read one server-advertised default branch at the actual, unambiguous push destination. */
function advertisedDefault(remote: string, destination?: string): RemoteDefault {
  const destinations = destination === undefined
    ? git(["remote", "get-url", "--push", "--all", remote]).split("\n") : [destination];
  if (destinations.length !== 1 || !destinations[0]) throw new Error("Push destination is ambiguous.");
  const pushDestination = destinations[0];
  const advertised = git(["ls-remote", "--symref", "--", pushDestination, "HEAD"]).split("\n");
  const refs = advertised.filter(line => /^ref: refs\/heads\/[^\s]+\tHEAD$/.test(line));
  const commits = advertised.filter(line => /^[a-f0-9]{40,64}\tHEAD$/.test(line));
  if (refs.length !== 1 || commits.length !== 1 || advertised.length !== 2) throw new Error();
  const defaultRef = refs[0].slice(5, -5);
  const defaultHead = commits[0].split("\t")[0];
  return { ref: defaultRef, head: defaultHead };
}

/** Preserve fast-forward deltas and select a unique accepted base for rewritten topics. */
function publishedBase(getDefault: () => RemoteDefault, target: string, old: string, head: string): string {
  // Preserve ordinary incremental review, including pushes to the default branch.
  if (git(["rev-parse", "--verify", "--end-of-options", `${old}^{commit}`]) !== old) {
    throw new Error("Cannot resolve the previous remote commit. Fetch it before pushing.");
  }
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", old, head], { stdio: "ignore", timeout: 10000 });
  if (ancestor.status === 0) return old;
  if (ancestor.status !== 1) throw new Error("Cannot verify pushed commit ancestry.");

  // A local tracking ref or ROBIN_BASE can point at the proposed head itself.
  // Only the server's current default branch may exclude inherited source.
  let base: string;
  try {
    const { ref: defaultRef, head: defaultHead } = getDefault();
    // Never omit changes in a force push to the default branch by comparing it
    // with a replacement default tip from the same multi-ref push.
    base = target === defaultRef ? old : defaultHead;
    if (git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]) !== base) throw new Error();
  } catch {
    throw new Error("Cannot verify the advertised remote default branch. Fetch its commit before pushing.");
  }
  const bases = git(["merge-base", "--all", head, base]).split("\n");
  if (bases.length !== 1 || !/^[a-f0-9]{40,64}$/.test(bases[0])) {
    throw new Error("Cannot select a unique review base for the published branch.");
  }
  return bases[0];
}

/** Git sends one ref update per stdin line. Review only immutable commits being sent. */
export async function prePush(remote: string, destination?: string): Promise<number> {
  const updates = readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
  if (process.env.ROBIN_SKIP === "1") {
    process.stderr.write("ROBIN_SKIP=1: skipping local Robin review.\n");
    return 0;
  }
  let defaultBranch: RemoteDefault | undefined;
  const getDefault = () => defaultBranch ?? (defaultBranch = advertisedDefault(remote, destination));
  const reviews: { head: string; target: string; base: string }[] = [];
  for (const update of updates) {
    const fields = update.trim().split(/\s+/);
    const [, head, target, old] = fields;
    if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(old)) {
      throw new Error("Invalid Git pre-push input.");
    }
    if (/^0+$/.test(head) || !target.startsWith("refs/heads/")) continue;
    if (git(["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`]) !== head) {
      throw new Error("Cannot resolve the pushed commit.");
    }
    let base = old;
    if (/^0+$/.test(base)) {
      try {
        const ref = process.env.ROBIN_BASE || execFileSync("git", ["symbolic-ref", `refs/remotes/${remote}/HEAD`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        base = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch {
        throw new Error("Cannot resolve the remote default branch. Fetch it and set ROBIN_BASE to a local base ref if needed.");
      }
    }
    else base = publishedBase(getDefault, target, old, head);
    reviews.push({ head, target, base });
  }
  // Validate every immutable ref update before contacting any model.
  for (const { head, target, base } of reviews) {
    process.stderr.write(`Robin: reviewing push to ${target}.\n`);
    const code = await new Promise<number>((done) => {
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "review", "--base", base, "--head", head, "--fail-on", "high"], { stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", () => done(2));
      child.on("exit", code => done(code ?? 2));
    });
    if (code !== 0) return code;
  }
  return 0;
}
