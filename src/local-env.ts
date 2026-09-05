import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse } from "dotenv";

/** Read provider settings as data, never source a shell file or modify process.env. */
export function loadLocalEnv(
  env: NodeJS.ProcessEnv = process.env,
  configPath = join(homedir(), ".config", "robin", ".env")
): NodeJS.ProcessEnv {
  const result = { ...env };
  let contents: string;
  try { contents = readFileSync(configPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw new Error("Cannot read Robin global configuration at ~/.config/robin/.env.");
  }
  const settings = parse(contents);
  for (const key of ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY"]) {
    if (result[key] === undefined && settings[key] !== undefined) result[key] = settings[key];
  }
  return result;
}
