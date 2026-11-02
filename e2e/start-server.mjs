/**
 * Starts an ISOLATED Sentinel for the end-to-end tests:
 *  - recreates the `sentinel_e2e` database inside the local Compose Postgres
 *    (never the developer's `sentinel` database, never port 5432);
 *  - builds the console and starts the API on :4100 in MOCK mode
 *    (no Airwallex keys, Mock AI), with demo users bootstrapped and their
 *    tokens written to e2e/.tokens.json (git-ignored).
 * Used as Playwright's webServer command.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tokensFile = fileURLToPath(new URL("./.tokens.json", import.meta.url));
// docker is a real executable (no shell, so SQL stays one argument).
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
// pnpm is a .cmd shim on Windows, so it runs through the shell as one fixed command string.
const pnpm = (command) => execSync(`pnpm ${command}`, { cwd: root, stdio: "inherit" });

run("docker", ["compose", "up", "-d", "--wait", "postgres"]);
run("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "sentinel", "-d", "sentinel", "-qc", "DROP DATABASE IF EXISTS sentinel_e2e WITH (FORCE)"]);
run("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "sentinel", "-d", "sentinel", "-qc", "CREATE DATABASE sentinel_e2e"]);
pnpm("build:web");
rmSync(tokensFile, { force: true });

const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  DATABASE_URL: "postgres://sentinel:sentinel_local_dev@127.0.0.1:54329/sentinel_e2e",
  SENTINEL_ORGANIZATION_ID: "e2e00000-0000-4000-8000-000000000e2e",
  SENTINEL_DEMO_BOOTSTRAP: "1",
  SENTINEL_DEMO_TOKENS_FILE: tokensFile,
  SENTINEL_INVESTIGATOR: "mock",
  APPROVAL_HMAC_SECRET: randomBytes(32).toString("hex"),
  PORT: "4100",
  HOST: "127.0.0.1",
  POLL_INTERVAL_MS: "60000",
};
const api = spawn("pnpm --filter @sentinel/api exec tsx src/main.ts", { cwd: root, env, stdio: "inherit", shell: true });
const stop = () => api.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
api.on("exit", (code) => process.exit(code ?? 0));
