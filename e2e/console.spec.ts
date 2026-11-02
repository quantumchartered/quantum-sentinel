import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

/**
 * Console end to end, in MOCK mode (no Airwallex calls, Mock AI), against an
 * isolated database. Runs in order: the first test sees an empty tenant.
 * Screenshots of key screens and states go to docs/screenshots/.
 */

type Role = "OWNER" | "OPERATOR" | "APPROVER" | "VIEWER";
const tokens = (): Record<Role, string> => JSON.parse(readFileSync(fileURLToPath(new URL("./.tokens.json", import.meta.url)), "utf8")).tokens;
const shot = (page: Page, name: string) => page.screenshot({ path: fileURLToPath(new URL(`../docs/screenshots/${name}.png`, import.meta.url)), fullPage: false });

/** Sign in without the UI (the UI sign-in itself is covered by its own test). */
async function as(page: Page, role: Role) {
  await page.addInitScript((t) => sessionStorage.setItem("sentinel.token", t), tokens()[role]);
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, "page must not scroll sideways").toBeLessThanOrEqual(width);
}

let incidentA = "";

test.describe.configure({ mode: "serial" });

test("sign-in rejects a wrong token, accepts a real one, and shows honest mode badges", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to the operator console" })).toBeVisible();
  await shot(page, "01-sign-in");

  await page.getByLabel("Sign-in token").fill("sst_this_is_not_a_real_token_000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not sign in");

  await page.getByLabel("Sign-in token").fill(tokens().OPERATOR);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Airwallex not connected: mock only")).toBeVisible();
  await expect(page.getByText("Mock AI (no API key)")).toBeVisible();
  await expect(page.getByText("No incidents yet")).toBeVisible(); // empty state on a fresh tenant
  await shot(page, "02-overview-empty");
});

test("loading and error states", async ({ page }) => {
  await as(page, "VIEWER");
  // Loading: hold the incidents request.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/incidents", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/incidents");
  await expect(page.getByRole("status")).toBeVisible();
  await shot(page, "03-loading");
  const done = page.waitForResponse("**/api/incidents");
  release();
  await done;
  await page.unroute("**/api/incidents");

  // Error: the API fails.
  await page.route("**/api/incidents", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal error", reasons: [] }) }));
  await page.goto("/incidents");
  await expect(page.getByRole("alert")).toContainText("Could not load incidents");
  await shot(page, "04-error");
  await page.unroute("**/api/incidents");

  // Not found.
  await page.goto("/incidents/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("alert")).toContainText("incident not found");
});

test("Scenario A, operator: WAIT, blocked resend, bank return, REPLACE, AI proposes", async ({ page }) => {
  await as(page, "OPERATOR");
  await page.goto("/lab");
  await shot(page, "05-scenario-lab");
  await page.getByRole("button", { name: "Start in mock mode" }).first().click();
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);
  incidentA = page.url().split("/").pop()!;

  await expect(page.getByText("WAIT", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Mock scenario").first()).toBeVisible();

  await page.getByRole("button", { name: "Run investigator" }).click();
  await expect(page.getByText("Verified")).toBeVisible();

  await page.getByRole("button", { name: "Resend anyway" }).click();
  await expect(page.getByText("Resend blocked by policy. No money moved.")).toBeVisible();
  await expect(page.getByText("Sending a replacement now could pay the supplier twice.").last()).toBeVisible();
  await shot(page, "06-workspace-wait-resend-blocked");

  // Advisory estimate: labelled, and a forbidden replacement is never priced.
  const estimate = page.locator("section", { has: page.getByRole("heading", { name: /Arrival and cost estimate/ }) });
  await expect(estimate.getByText("ILLUSTRATIVE PRIORS")).toBeVisible();
  await expect(estimate.getByText("Forbidden by policy")).toBeVisible();
  await expect(estimate.getByText("Agrees with the policy recommendation.")).toBeVisible();
  await estimate.scrollIntoViewIfNeeded();
  await shot(page, "14-cost-estimate-wait");

  await page.getByRole("button", { name: "Original fails: bank return" }).click();
  await page.getByRole("button", { name: "Re-evaluate" }).click();
  await expect(page.getByText("REPLACE", { exact: true }).first()).toBeVisible();
  // The stale "resend blocked" panel from the WAIT decision is gone.
  await expect(page.getByText("Resend blocked by policy. No money moved.")).toHaveCount(0);
  await expect(page.getByText("Out of date: this analysis explains the earlier WAIT decision.")).toBeVisible();
  await expect(estimate.getByText("Forbidden by policy")).toHaveCount(0);
  await expect(estimate.getByRole("row", { name: /REPLACE.*lowest/ })).toBeVisible();
  await expect(estimate.getByText("0%", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Run investigator" }).click();
  await expect(page.getByText("Changed from WAIT to REPLACE")).toBeVisible();
  await expect(page.getByText("is waiting for approval")).toBeVisible();
  await shot(page, "07-workspace-replace-proposed");
});

test("viewer sees the incident but no actions", async ({ page }) => {
  await as(page, "VIEWER");
  await page.goto(`/incidents/${incidentA}`);
  await expect(page.getByRole("heading", { name: "Recommendation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resend anyway" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run investigator" })).toHaveCount(0);
  await page.goto("/approvals");
  await expect(page.getByText("Only approvers can sign.")).toBeVisible();
});

test("Approval Center: approver signs the bound facts; the payment is sent once", async ({ page }) => {
  await as(page, "APPROVER");
  await page.goto("/approvals");
  await expect(page.getByText("You are signing exactly these facts")).toBeVisible();
  await expect(page.getByText("USD 25,000.00").first()).toBeVisible();
  await shot(page, "08-approval-center");
  await page.getByRole("button", { name: "Approve and send…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Send USD 25,000.00?");
  await dialog.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByRole("region", { name: "Just decided" })).toContainText("Approved and sent.");
  await expect(page.getByText("Approved and sent.")).toHaveCount(1);
  await expect(page.getByText("Nothing waiting for approval")).toBeVisible();
  await shot(page, "09-approved");
});

test("Scenario A completes: replacement PAID, resolved with the original's fate", async ({ page, request }) => {
  const auth = { authorization: `Bearer ${tokens().OPERATOR}` };
  expect((await request.post(`/api/lab/incidents/${incidentA}/events`, { headers: auth, data: { event: "REPLACEMENT_PAID" } })).ok()).toBe(true);
  await as(page, "OPERATOR");
  await page.goto(`/incidents/${incidentA}`);
  await page.getByRole("button", { name: "Check and resolve" }).click();
  await expect(page.getByText("Resolved. Settled by the replacement payment.")).toBeVisible();
  await expect(page.getByText("RETURNED: BENEFICIARY_BANK_RETURNED")).toBeVisible();
});

test("Decision Replay shows what was known when WAIT became REPLACE", async ({ page }) => {
  await as(page, "VIEWER");
  await page.goto(`/incidents/${incidentA}/replay`);
  await expect(page.getByRole("heading", { name: "Decision Replay" })).toBeVisible();
  await page.getByRole("button", { name: /Decision: REPLACE/ }).click();
  await expect(page.getByText("Decision changed: WAIT → REPLACE")).toBeVisible();
  await expect(page.getByText("Why (decided by code)")).toBeVisible();
  await shot(page, "10-decision-replay");
  // Step controls use accessible names ("Previous step" / "Next step").
  const position = page.getByText(/^\d+ \/ \d+$/);
  const before = await position.innerText();
  await page.getByRole("button", { name: "Next step" }).click();
  await expect(position).not.toHaveText(before);
});

test("a late return of the paid replacement reopens the resolved incident and escalates it", async ({ page }) => {
  await as(page, "OPERATOR");
  await page.goto(`/incidents/${incidentA}`);
  await page.getByRole("button", { name: "Paid replacement returned later" }).click();
  await expect(page.getByText("Escalated to a person").first()).toBeVisible();
  await expect(page.getByText(/Escalated: Reopened after resolution\. The replacement payment that settled this invoice failed after PAID/)).toBeVisible();
  await expect(page.getByText("Earlier policy decision: REPLACE")).toBeVisible();
  await shot(page, "17-reopened-after-paid");
  await page.goto(`/incidents/${incidentA}/replay`);
  await expect(page.getByRole("button", { name: /Reopened after resolution/ })).toBeVisible();
});

test("Scenario C: the fraud email escalates and payment is blocked", async ({ page }) => {
  await as(page, "OPERATOR");
  await page.goto("/lab");
  await page.getByRole("button", { name: "Start in mock mode" }).nth(2).click();
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);
  await expect(page.getByText("ESCALATE", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Payment blocked by risk flags. Only a person can clear this.")).toBeVisible();
  await expect(page.getByText("Untrusted").first()).toBeVisible();
  await shot(page, "11-scenario-c-escalated");
});

test("Scenario B race: ten approvers and ten executors produce one transfer", async ({ page, request }) => {
  const auth = { authorization: `Bearer ${tokens().OPERATOR}` };
  const created = await (await request.post("/api/lab/scenarios", { headers: auth, data: { scenario: "B", mode: "MOCK" } })).json();
  expect((await request.post(`/api/incidents/${created.incidentId}/propose`, { headers: auth })).ok()).toBe(true);
  await as(page, "OPERATOR");
  await page.goto("/lab");
  await page.getByRole("button", { name: "Fire 10 approvals + 10 executors at once" }).click();
  await expect(page.getByText("Transfers sent to the provider")).toBeVisible();
  await shot(page, "12-race-result");
  const counts = await page.getByRole("status", { name: "Race result" }).innerText();
  expect(counts).toMatch(/Approvals granted\s*1/);
  expect(counts).toMatch(/Transfers sent to the provider\s*1/);
});

test("Audit log verifies the hash chain", async ({ page }) => {
  await as(page, "VIEWER");
  await page.goto("/audit");
  await expect(page.getByText(/Chain verified · \d+ entries/)).toBeVisible();
});

test("Agent Activity lists each investigator run with its tool calls and verifier result", async ({ page }) => {
  await as(page, "VIEWER");
  await page.goto("/agent");
  await expect(page.getByRole("heading", { name: "Agent Activity" })).toBeVisible();
  await expect(page.getByText(/Tool calls \(\d+\)/).first()).toBeVisible();
  await expect(page.getByText(/Passed · \d+ warnings/).first()).toBeVisible();
  await expect(page.getByText("mock-investigator").first()).toBeVisible();
  await shot(page, "15-agent-activity");
});

test("Reconciliation: an operator runs it and the books check out", async ({ page }) => {
  await as(page, "VIEWER");
  await page.goto("/reconciliation");
  await expect(page.getByRole("heading", { name: "Reconciliation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run reconciliation" })).toHaveCount(0);

  await as(page, "OPERATOR");
  await page.goto("/reconciliation");
  await page.getByRole("button", { name: "Run reconciliation" }).click();
  await expect(page.getByText("No errors")).toBeVisible();
  await expect(page.getByRole("row", { name: /Owed to suppliers/ })).toBeVisible();
  await shot(page, "16-reconciliation");
});

test("narrow screens (375px): no sideways scrolling on any page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await as(page, "OWNER");
  for (const path of ["/", "/incidents", `/incidents/${incidentA}`, `/incidents/${incidentA}/replay`, "/approvals", "/lab", "/agent", "/reconciliation", "/audit"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await noHorizontalOverflow(page);
  }
  await page.goto(`/incidents/${incidentA}`);
  await page.waitForLoadState("networkidle");
  await shot(page, "13-narrow-workspace");
});
