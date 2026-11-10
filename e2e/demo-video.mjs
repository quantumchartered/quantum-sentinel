/* global document, sessionStorage -- these run inside the browser page */
// Records a captioned, silent demo video of the console (under 5 minutes).
// Needs the API on :4000 (with sandbox keys for part 4) and .local/demo-tokens.json.
// Usage: node e2e/demo-video.mjs <sandboxIncidentId> [path/to/sandbox-run.txt]
// Output: .local/video/quantum-sentinel-demo.webm (git-ignored). Prints no tokens.
import { readFileSync, renameSync } from "node:fs";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:4000";
const [sandboxIncident, runLogPath = fileURLToPath(new URL("../.local/video/sandbox-run.txt", import.meta.url))] = process.argv.slice(2);
if (!sandboxIncident) throw new Error("usage: node e2e/demo-video.mjs <sandboxIncidentId> [sandbox-run.txt]");
const tokens = JSON.parse(readFileSync(fileURLToPath(new URL("../.local/demo-tokens.json", import.meta.url)), "utf8")).tokens;
const runLog = readFileSync(runLogPath, "utf8").trim();
const outDir = fileURLToPath(new URL("../.local/video/", import.meta.url));
const started = Date.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  colorScheme: "dark",
  recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);

/** Bottom caption bar. Reading time scales with length. */
async function say(text, ms = Math.max(3500, text.length * 55)) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText =
        "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:1040px;z-index:99999;pointer-events:none;" +
        "background:rgba(8,12,20,.94);color:#f4f6fb;border:1px solid #3b82f6;border-radius:10px;" +
        "padding:14px 22px;font:500 21px/1.4 system-ui,Segoe UI,sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.5)";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await wait(ms);
}
const hideCaption = () => page.evaluate(() => document.getElementById("demo-caption")?.remove());

/** Full-screen card for titles and the recorded sandbox output. */
async function card(html, ms) {
  await page.evaluate((h) => {
    const el = document.createElement("div");
    el.id = "demo-card";
    el.style.cssText =
      "position:fixed;inset:0;z-index:100000;background:#0b1020;color:#eef2fb;display:flex;flex-direction:column;" +
      "justify-content:center;align-items:center;padding:48px;font:400 22px/1.5 system-ui,Segoe UI,sans-serif;text-align:center";
    el.innerHTML = h;
    document.body.appendChild(el);
  }, html);
  await wait(ms);
  await page.evaluate(() => document.getElementById("demo-card")?.remove());
}

/** Outline an element so the viewer knows where to look. */
async function spot(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el) => {
    el.style.outline = "3px solid #fbbf24";
    el.style.outlineOffset = "4px";
    el.style.borderRadius = "8px";
  });
}

async function signInAs(role, path) {
  await page.goto(BASE + "/");
  await page.evaluate((t) => sessionStorage.setItem("sentinel.token", t), tokens[role]);
  await page.goto(BASE + path);
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

process.on("unhandledRejection", async (err) => {
  await page.screenshot({ path: outDir + "failure.png" }).catch(() => {});
  console.error(err);
  process.exit(1);
});

// ---------- 0. Title ----------
await page.goto(BASE + "/");
await card(
  `<div style="font-size:52px;font-weight:700;letter-spacing:-.02em">Quantum Sentinel</div>
   <div style="margin-top:12px;font-size:26px;color:#9fb3d9">The AI financial-operations employee for global businesses</div>
   <div style="margin-top:36px;font-size:19px;color:#8090ad">Airwallex Agentic Banking Hackathon 2026 · Kit 3: Payment Ops Incident Commander</div>
   <div style="margin-top:8px;font-size:17px;color:#6b7a96">Sandbox only · no real money · captions describe each step</div>`,
  7000,
);

// ---------- 1. The problem ----------
await signInAs("OPERATOR", "/");
await page.getByRole("heading", { name: "Overview" }).waitFor();
await say("A supplier payment is late. The supplier says it never arrived. Wait, send it again, or escalate?");
await say("Send it again too early and you pay twice. Today that call is made by hand, with no record of why.");
await spot(page.getByText("Airwallex sandbox", { exact: true }));
await say("Sentinel runs on Airwallex. It investigates, recommends WAIT, REPLACE or ESCALATE, and cannot pay twice.");

// ---------- 2. Scenario A: WAIT, unsafe click blocked ----------
await page.goto(BASE + "/lab");
await say("Scenario Lab: start Scenario A, a delayed USD 25,000 supplier payment (simulated provider, clearly labelled).", 5000);
await page.getByRole("button", { name: "Start in mock mode" }).first().click();
await page.waitForURL(/\/incidents\/[0-9a-f-]{36}$/);
const recCard = page.locator("section", { has: page.getByRole("heading", { name: "Recommendation" }) });
await spot(recCard);
await say("The transfer is SENT at the provider and two days overdue. The supplier emailed: payment not received.");
await say("Recommendation: WAIT. Decided by code, not by the AI: the money is in flight, so a second payment could pay twice.");
await page.getByRole("button", { name: "Run investigator" }).click();
await page.getByText("Verified").first().waitFor();
await spot(page.locator("section", { has: page.getByRole("heading", { name: "AI investigation" }) }));
await say("The AI investigator explains the decision. Every claim links to evidence; a verifier rejects anything unsupported.");
await say("The AI can read and propose. It can never move money.", 3500);
await page.getByRole("button", { name: "Resend anyway" }).click();
await page.getByText("Resend blocked by policy. No money moved.").waitFor();
await spot(page.getByText("Resend blocked by policy. No money moved."));
await say("A stressed operator clicks Resend anyway. Policy blocks it, explains why, and records it in the audit log.");
await spot(page.locator("section", { has: page.getByRole("heading", { name: /Arrival and cost estimate/ }) }));
await say("An advisory cost estimate, labelled as illustrative, agrees: waiting is cheapest. A replacement is not even priced.");

// ---------- 3. New evidence changes the decision ----------
await page.getByRole("button", { name: "Original fails: bank return" }).click();
await say("New evidence: the beneficiary's bank returned the payment. On Airwallex, FAILED turns into CANCELLED within seconds.");
await page.getByRole("button", { name: "Re-evaluate" }).click();
await page.getByText("REPLACE", { exact: true }).first().waitFor();
await spot(recCard);
await say("Sentinel kept the failure reason, so the recommendation really changes: REPLACE.");
await page.getByRole("button", { name: "Run investigator" }).click();
await page.getByText("Changed from WAIT to REPLACE").waitFor();
await spot(page.getByText("Changed from WAIT to REPLACE"));
await say("It shows exactly what changed and why, and proposes a replacement for approval.");

await signInAs("APPROVER", "/approvals");
await page.getByText("You are signing exactly these facts").first().waitFor();
await spot(page.getByText("You are signing exactly these facts").first());
await say("A second person approves. The signature binds amount, currency, beneficiary, evidence and provider state.");
await say("If any of those change, the approval dies. Whoever proposed a payment can never approve it.");
await page.getByRole("button", { name: "Approve and send…" }).first().click();
await page.getByRole("dialog").getByRole("button", { name: "Approve and send" }).click();
await page.getByText("Approved and sent.").first().waitFor();
await say("The executor re-checks everything with the provider, then sends the replacement with a new request ID.");

// ---------- 4. The real Airwallex sandbox ----------
await card(
  `<div style="font-size:34px;font-weight:700">The same product code, on the real Airwallex sandbox</div>
   <div style="margin-top:12px;color:#9fb3d9">pnpm sandbox scenario-a · real sandbox API calls, simulated funds</div>`,
  4500,
);
await card(
  `<div style="font-size:15px;color:#fbbf24;margin-bottom:10px;letter-spacing:.06em">RECORDED SANDBOX RUN · ${new Date().toISOString().slice(0, 10)}</div>
   <pre style="text-align:left;max-width:1180px;max-height:600px;overflow:hidden;margin:0;padding:18px 22px;background:#05080f;border:1px solid #26324a;border-radius:10px;font:13px/1.45 Consolas,monospace;color:#c9d6ee;white-space:pre-wrap">${esc(runLog)}</pre>`,
  16000,
);
await signInAs("VIEWER", `/incidents/${sandboxIncident}`);
await page.getByRole("heading", { name: "Recommendation" }).waitFor();
await spot(page.getByText("Sandbox scenario", { exact: true }).first());
await say("That run in the console: labelled sandbox, resolved, settled by the replacement, original returned by the bank.");
await spot(page.getByText(/Resolved\. Settled by the replacement payment/));
await say("The incident closes only after Sentinel records what happened to the original. The books are posted.");

// ---------- 5. Decision Replay ----------
await page.getByRole("link", { name: "Decision Replay" }).click();
await page.getByRole("heading", { name: "Decision Replay" }).waitFor();
await page.getByRole("button", { name: /Decision: REPLACE/ }).click();
await page.getByText("Decision changed: WAIT → REPLACE").waitFor();
await spot(page.getByText("Decision changed: WAIT → REPLACE"));
await say("Decision Replay rebuilds every step from the tamper-evident audit log: what was known, blocked, approved and done.");

// ---------- 6. Fraud and races ----------
await signInAs("OPERATOR", "/lab");
await page.getByRole("button", { name: "Start in mock mode" }).nth(2).click();
await page.waitForURL(/\/incidents\/[0-9a-f-]{36}$/);
await page.getByText("Payment blocked by risk flags. Only a person can clear this.").waitFor();
await spot(page.getByText("Payment blocked by risk flags. Only a person can clear this."));
await say("Scenario C: an email posing as the supplier asks to pay a new bank account and tries to instruct the AI.");
await say("Code catches it: ESCALATE, payment blocked, and only a person can clear it.", 4000);

const auth = { authorization: `Bearer ${tokens.OPERATOR}` };
const created = await (await page.request.post(BASE + "/api/lab/scenarios", { headers: auth, data: { scenario: "B", mode: "MOCK" } })).json();
await page.request.post(`${BASE}/api/incidents/${created.incidentId}/propose`, { headers: auth });
await page.goto(BASE + "/lab");
await page.getByRole("button", { name: "Fire 10 approvals + 10 executors at once" }).click();
await page.getByText("Transfers sent to the provider").waitFor();
await spot(page.getByRole("status", { name: "Race result" }));
await say("Scenario B: ten approvers and ten executors fire at once. One approval. One transfer.");

await page.goto(BASE + "/audit");
await page.getByText(/Chain verified · \d+ entries/).waitFor();
await spot(page.getByText(/Chain verified · \d+ entries/));
await say("Every action is in a hash-chained audit log. Editing, deleting or reordering any entry is detected.", 4500);
await hideCaption();

// ---------- 7. Proof and close ----------
await card(
  `<div style="font-size:30px;font-weight:700;margin-bottom:22px">Proof, not promises</div>
   <div style="font-size:21px;line-height:1.9;color:#d5ddef">
     187 unit tests · 129 database tests · 14 browser tests<br/>
     33 attacks run, 0 succeeded · 24 of 24 evaluation cases pass<br/>
     TLA+ model of "never pay twice", checked over 1.4 million states: it found a real race, now fixed<br/>
     Scenario A run end to end on the real Airwallex sandbox
   </div>
   <div style="margin-top:22px;font-size:16px;color:#8090ad">The AI in this demo is the labelled Mock AI (no live model key). The cost estimate uses illustrative priors.</div>`,
  11000,
);
await card(
  `<div style="font-size:46px;font-weight:700">Quantum Sentinel</div>
   <div style="margin-top:14px;font-size:22px;color:#9fb3d9">Investigates payment problems, safely coordinates their resolution,<br/>and explains every financial decision.</div>`,
  5000,
);

const video = page.video();
await context.close();
await browser.close();
const out = fileURLToPath(new URL("../.local/video/quantum-sentinel-demo.webm", import.meta.url));
renameSync(await video.path(), out);
console.log(`video: .local/video/quantum-sentinel-demo.webm (${Math.round((Date.now() - started) / 1000)} s)`);
