import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadLocalEnv } from "./local-env";
let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "robin-env-")); file = join(dir, ".env"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test("loads quoted values, export declarations and comments without evaluating shell expressions", () => {
  writeFileSync(file, '# config\nexport LLM_BASE_URL="http://localhost:11434/v1"\nLLM_MODEL=test # comment\nLLM_API_KEY=\'fake-$(whoami)-${USER}#key\'\nNODE_OPTIONS=--unwanted\n');
  expect(loadLocalEnv({}, file)).toEqual({ LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "test", LLM_API_KEY: "fake-$(whoami)-${USER}#key" });
});
test("shell variables including explicit empty values override file settings without mutation", () => {
  writeFileSync(file, 'LLM_MODEL=file-model\nLLM_API_KEY=fake-key\n');
  const env = { LLM_MODEL: "shell-model", LLM_API_KEY: "" };
  expect(loadLocalEnv(env, file)).toEqual(env); expect(env).toEqual({ LLM_MODEL: "shell-model", LLM_API_KEY: "" });
});
test("missing config is optional", () => { expect(loadLocalEnv({ LLM_MODEL: "test" }, file)).toEqual({ LLM_MODEL: "test" }); });
test("unreadable config produces a safe error", () => {
  expect(() => loadLocalEnv({}, dir)).toThrow("Cannot read Robin global configuration");
});
