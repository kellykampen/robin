import { execFileSync, spawn } from "child_process";
import { readFileSync } from "fs";

/** Git sends one ref update per stdin line. Review only immutable commits being sent. */
export async function prePush(remote: string): Promise<number> {
  const updates = readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
  if (process.env.ROBIN_SKIP === "1") {
    process.stderr.write("ROBIN_SKIP=1: skipping local Robin review.\n");
    return 0;
  }
  for (const update of updates) {
    const fields = update.trim().split(/\s+/);
    const [, head, target, old] = fields;
    if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(old)) {
      throw new Error("Invalid Git pre-push input.");
    }
    if (/^0+$/.test(head) || !target.startsWith("refs/heads/")) continue;
    let base = old;
    if (/^0+$/.test(base)) {
      try {
        const ref = process.env.ROBIN_BASE || execFileSync("git", ["symbolic-ref", `refs/remotes/${remote}/HEAD`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        base = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch {
        throw new Error("Cannot resolve the remote default branch. Fetch it and set ROBIN_BASE to a local base ref if needed.");
      }
    }
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
