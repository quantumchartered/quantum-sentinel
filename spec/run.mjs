/**
 * Model-checks spec/Sentinel.tla with TLC (TLA+ tools 1.7.4, pinned by checksum in
 * spec/Dockerfile) and writes spec/RESULTS.md:
 *
 *   pnpm spec              the full matrix (the design, the pre-fix design, each defence removed)
 *   pnpm spec --only safe  one row
 *
 * Every row states what it expects. The run exits 1 if any row does not behave as
 * expected: the design must hold, and each mutant must behave as recorded, so a
 * change that silently weakens the model (or the design) is noticed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const specDir = fileURLToPath(new URL(".", import.meta.url));
const IMAGE = "sentinel-tlc:1.7.4";

const ALL_INVARIANTS = ["TypeOK", "NoDoublePayment", "FenceHeld", "AtMostOneBlocking"];

/**
 * expect "holds": TLC must explore every reachable state with no violation.
 * expect "violates": TLC must find a counterexample to NoDoublePayment.
 */
const ROWS = [
  {
    id: "safe",
    title: "The implemented design (every defence on)",
    disabled: [],
    invariants: ALL_INVARIANTS,
    expect: "holds",
  },
  {
    id: "safe-3-workers",
    title: "The implemented design, three workers",
    disabled: [],
    invariants: ALL_INVARIANTS,
    executors: ["e1", "e2", "e3"],
    expect: "holds",
  },
  {
    id: "safe-large",
    title: "The implemented design, three workers, three replacements, four claims",
    disabled: [],
    invariants: ALL_INVARIANTS,
    executors: ["e1", "e2", "e3"],
    replacements: ["r1", "r2", "r3"],
    maxAttempts: 4,
    expect: "holds",
  },
  {
    id: "pre-fix",
    title: "Current code: BLOCKED / REJECTED always release the fence",
    disabled: ["sole_attempt_release"],
    invariants: ["NoDoublePayment"],
    expect: "violates",
    why: "FOUND BY TLC, NOT YET FIXED IN CODE. Worker 1 claims the replacement and stalls past its lease. Worker 2 re-claims it (attempt 2), passes revalidation and sends. Worker 1 resumes, its revalidation is BLOCKED (for example a transient balance-read error) and it writes NOT_SENT. A transfer is now live with no fence, so a person can approve a second replacement, which is also sent. Planned fix in packages/db/src/execution.ts: release only when executions.attempts = 1; otherwise keep the payment UNCERTAIN and escalate.",
  },
  {
    id: "no-typed-failure",
    title: "Treat a timeout or bare CANCELLED as a confirmed failure",
    disabled: ["typed_failure"],
    invariants: ["NoDoublePayment"],
    expect: "violates",
    why: "The original is still in flight when the replacement goes out.",
  },
  {
    id: "no-unique-index",
    title: "Remove the partial unique index",
    disabled: ["unique_index"],
    invariants: ["NoDoublePayment"],
    expect: "holds",
    why: "decide()'s duplicate check runs under the obligation and incident row locks, at approval and again at revalidation, so it is atomic on its own. The index is the second layer.",
  },
  {
    id: "no-locked-checks",
    title: "Run the duplicate check without the row locks",
    disabled: ["locked_checks"],
    invariants: ["NoDoublePayment"],
    expect: "holds",
    why: "The partial unique index refuses the second blocking payment on its own.",
  },
  {
    id: "no-index-no-locks",
    title: "Remove both the index and the locked checks",
    disabled: ["unique_index", "locked_checks"],
    invariants: ["NoDoublePayment"],
    expect: "violates",
    why: "Two approvals both see no other blocking payment, so two replacements go out.",
  },
  {
    id: "no-stable-request-id",
    title: "A retry uses a new request_id",
    disabled: ["stable_request_id"],
    invariants: ["NoDoublePayment"],
    expect: "violates",
    why: "The provider cannot de-duplicate, so a retry after a lost response is a second transfer.",
  },
  {
    id: "no-revalidate",
    title: "Skip revalidation before sending",
    disabled: ["revalidate"],
    invariants: ["NoDoublePayment"],
    expect: "holds",
    why: "Within this model the approval's own checks and the unique index already cover it: FAILED never becomes live again (assumption A1). Revalidation still matters for what the model leaves out (balance, beneficiary, approval expiry).",
  },
  {
    id: "no-lookup",
    title: "Retry without looking the request_id up first",
    disabled: ["lookup"],
    invariants: ["NoDoublePayment"],
    expect: "holds",
    why: "With a stable request_id the provider de-duplicates the retry (assumption A2). The lookup avoids relying on that alone.",
  },
  {
    id: "no-lease",
    title: "Let two workers hold the same execution at once",
    disabled: ["lease"],
    invariants: ["NoDoublePayment"],
    expect: "holds",
    why: "Both send the same request_id, which the provider de-duplicates, and the release rule counts attempts, not lease holders.",
  },
];

/** Each must be violated in the full design: TLC reaches the state, so the proof is not vacuous. */
const WITNESSES = [
  { id: "witness-replaced", invariant: "NeverReplaced", title: "A replacement is sent and recorded as DISPATCHED" },
  { id: "witness-zombie", invariant: "NeverTwoWorkersOnOneJob", title: "Two workers run the same execution (lease expired)" },
  { id: "witness-held", invariant: "NeverHeldAfterBlock", title: "A BLOCKED retry keeps the fence (UNCERTAIN) instead of releasing it" },
  { id: "witness-lost-response", invariant: "NeverLiveUnderUncertain", title: "A transfer exists while Sentinel only knows the outcome is uncertain" },
].map((w) => ({ ...w, disabled: [], invariants: [w.invariant], expect: "violates", witness: true }));

function config(row) {
  const set = (xs) => `{${xs.join(", ")}}`;
  return [
    `\\* Generated by spec/run.mjs for row "${row.id}". Do not edit.`,
    "CONSTANTS",
    `  Executors = ${set(row.executors ?? ["e1", "e2"])}`,
    `  Replacements = ${set(row.replacements ?? ["r1", "r2"])}`,
    `  MaxAttempts = ${row.maxAttempts ?? 3}`,
    "  NoJob = NoJob",
    `  Disabled = ${set(row.disabled.map((d) => `"${d}"`))}`,
    "SYMMETRY Symmetry",
    "SPECIFICATION Spec",
    `INVARIANTS ${row.invariants.join(" ")}`,
    "",
  ].join("\n");
}

function ensureImage() {
  const has = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  if (has.status !== 0) execFileSync("docker", ["build", "-t", IMAGE, specDir], { stdio: "inherit" });
}

/** TLC prints full states; keep only what changed, so a trace reads as a story. */
function compactTrace(out) {
  const lines = out.split(/\r?\n/);
  const steps = [];
  let prev = {};
  let cur = null;
  for (const line of lines) {
    const head = /^State (\d+): <(\w+|Initial predicate)/.exec(line);
    if (head) {
      if (cur) steps.push(cur);
      cur = { n: Number(head[1]), action: head[2], vars: {} };
      continue;
    }
    const v = /^\/\\ (\w+) = (.*)$/.exec(line);
    if (cur && v) cur.vars[v[1]] = v[2];
  }
  if (cur) steps.push(cur);
  // Functions print as (r1 :> "a" @@ r2 :> "b"); flatten them to pay[r1], pay[r2], ...
  const flatten = (vars) => {
    const flat = {};
    for (const [k, val] of Object.entries(vars)) {
      const fn = /^\((.*)\)$/.exec(val);
      if (fn && fn[1].includes(":>")) {
        for (const part of fn[1].split(" @@ ")) {
          const [key, v] = part.split(" :> ");
          flat[`${k}[${key}]`] = v;
        }
      } else flat[k] = val;
    }
    return flat;
  };
  return steps.map((s) => {
    const vars = flatten(s.vars);
    const changed = Object.entries(vars).filter(([k, val]) => prev[k] !== val);
    prev = { ...prev, ...vars };
    const body = s.n === 1 ? "" : changed.map(([k, val]) => `${k} = ${val}`).join(", ");
    return `${String(s.n).padStart(2)}. ${s.action}${body ? `: ${body}` : ""}`;
  });
}

function check(row) {
  const dir = `${specDir}build`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${row.id}.cfg`, config(row));
  const t0 = Date.now();
  const r = spawnSync(
    "docker",
    ["run", "--rm", "-v", `${specDir}:/spec`, IMAGE, "-deadlock", "-workers", "auto", "-metadir", "/tmp/tlc", "-config", `build/${row.id}.cfg`, "Sentinel.tla"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  writeFileSync(`${dir}/${row.id}.out`, out);
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const stats = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(out);
  const depth = /depth of the complete state graph search is (\d+)/.exec(out);
  const violated = /Invariant (\w+) is violated/.exec(out);
  const completed = out.includes("Model checking completed. No error has been found.");
  const result = violated ? "violates" : completed ? "holds" : "error";
  return {
    row,
    result,
    // A counterexample only counts if it is for the invariant the row is about.
    ok: result === row.expect && (result !== "violates" || violated[1] === row.invariants.at(-1)),
    invariant: violated?.[1] ?? null,
    generated: stats?.[1] ?? "?",
    distinct: stats?.[2] ?? "?",
    depth: depth?.[1] ?? null,
    seconds,
    trace: violated ? compactTrace(out) : [],
    error: result === "error" ? out.split(/\r?\n/).filter((l) => /error|Error|Exception/.test(l)).slice(0, 8).join("\n") : null,
  };
}

function render(all) {
  let results = all;
  const L = [];
  const commit = (() => {
    try {
      const c = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["status", "--porcelain", "--", specDir, ":(exclude)spec/RESULTS.md", ":(exclude)spec/build"], { encoding: "utf8" }).trim();
      return dirty ? `${c} plus uncommitted changes` : c;
    } catch {
      return null;
    }
  })();
  L.push("# Model-checking results");
  L.push("");
  L.push(
    `Generated by \`pnpm spec\` on ${new Date().toISOString()}${commit ? ` at commit \`${commit}\`` : ""} with TLC 2.19 (TLA+ tools 1.7.4). ` +
      "Model: `spec/Sentinel.tla`, 1 obligation, 2 replacement payments, up to 3 claims per execution, symmetry reduction on workers and payments. " +
      "TLC checks **every** reachable state of that bounded model, not a sample. It proves nothing about larger configurations or about code the model leaves out; see `spec/README.md` for the mapping and the assumptions.",
  );
  L.push("");
  L.push("| Row | Defences removed | Expected | Result | Distinct states | Depth | Time |");
  L.push("| --- | --- | --- | --- | ---: | ---: | ---: |");
  const witnesses = results.filter((r) => r.row.witness);
  results = results.filter((r) => !r.row.witness);
  for (const r of results) {
    const res = r.result === "violates" ? `**${r.invariant} violated**` : r.result === "holds" ? "all invariants hold" : "ERROR";
    L.push(
      `| ${r.row.title} | ${r.row.disabled.length ? r.row.disabled.map((d) => `\`${d}\``).join(", ") : "none"} | ${r.row.expect === "holds" ? "holds" : "counterexample"} | ${res} ${r.ok ? "✓" : "✗ UNEXPECTED"} | ${r.result === "holds" ? r.distinct : "-"} | ${r.depth ?? (r.trace.length ? `trace ${r.trace.length}` : "-")} | ${r.seconds}s |`,
    );
  }
  L.push("");
  L.push("Invariants checked on the design rows: `TypeOK`, `NoDoublePayment` (at most one transfer for the obligation can deliver money), `FenceHeld` (every transfer that can still move money has a payment record holding the obligation's fence), `AtMostOneBlocking` (the database never holds two blocking payments). Mutant rows check `NoDoublePayment` only, so a counterexample is an actual double payment.");
  if (witnesses.length) {
    L.push("");
    L.push("**Not vacuous.** In the full design TLC must also *reach* each of these states (checked by asserting the state never happens and expecting a counterexample):");
    L.push("");
    L.push("| State reached | Result | Steps |");
    L.push("| --- | --- | ---: |");
    for (const w of witnesses) L.push(`| ${w.row.title} | ${w.result === "violates" ? "reached ✓" : "NOT REACHED ✗"} | ${w.trace.length || "-"} |`);
  }
  for (const r of results.filter((x) => x.row.why || x.trace.length || x.error)) {
    L.push("");
    L.push(`## ${r.row.title}`);
    L.push("");
    if (r.row.why) L.push(r.row.why);
    if (r.trace.length) {
      L.push("");
      L.push("Shortest counterexample found by TLC (breadth-first), showing only what changed at each step:");
      L.push("");
      L.push("```");
      L.push(...r.trace);
      L.push("```");
    }
    if (r.error) L.push("", "```", r.error, "```");
  }
  L.push("");
  return L.join("\n");
}

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
ensureImage();
const results = [];
for (const row of [...ROWS, ...WITNESSES].filter((r) => !only || r.id === only)) {
  const r = check(row);
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${row.id.padEnd(22)} expected ${row.expect.padEnd(8)} got ${r.result}${r.invariant ? ` (${r.invariant})` : ""}  ${r.distinct} states  ${r.seconds}s`);
  if (r.trace.length && only) console.log(r.trace.join("\n"));
  if (r.error) console.log(r.error);
  results.push(r);
}
if (!only) {
  writeFileSync(`${specDir}RESULTS.md`, render(results));
  console.log("Written to spec/RESULTS.md");
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
