# Demo video script (target 4:30, limit 5:00)

> **A ready-made, captioned (silent) recording exists:** `node e2e/demo-video.mjs <sandboxIncidentId>` with the API running writes `.local/video/quantum-sentinel-demo.webm` (about 3 minutes; git-ignored). It follows this script, shows the real sandbox run labelled "Recorded sandbox run", and needs no voice. Use the script below if you prefer to record yourself with narration.

Read the **Say** lines out loud while doing the **Do** lines. Times are a guide. Practise once without recording.

## Before you press record

1. Close everything personal on screen (email, chat, other tabs). Never show the `.env` file or the tokens file.
2. Start the app, in PowerShell, in the project folder:
   ```bash
   docker compose up --build
   ```
   Wait until it says `Quantum Sentinel ready`.
3. Open http://localhost:4000. Open `.local/demo-tokens.json` in Notepad **off-camera**, copy the `OPERATOR` token, paste it into the sign-in box, sign in, then close Notepad.
4. Open a second PowerShell window in the project folder for the live sandbox run (part 4). Make the text large (Ctrl + mouse wheel).
5. Record the screen: **Win + Alt + R** (Xbox Game Bar), OBS or Loom. Record your voice too.

---

## 1. The problem (0:00 – 0:30)

**Do:** show the Overview page.

**Say:** "Every business that pays international suppliers has this problem: a payment is late, the supplier says it never arrived, and someone has to decide whether to wait, send it again, or escalate. Send it again too early and you pay twice. Quantum Sentinel is an AI payment-operations employee on Airwallex that investigates these incidents, recommends wait, replace or escalate, changes its mind when the evidence changes, and cannot pay twice."

## 2. Scenario A: wait, and the unsafe click is blocked (0:30 – 1:30)

**Do:** Scenario Lab → **Start in mock mode** on Scenario A.

**Say:** "Here is a twenty-five thousand dollar supplier payment. The transfer is SENT at the provider, it is two days past due, and the supplier has emailed to say it never arrived."

**Do:** point at the big **WAIT** and its three reasons.

**Say:** "Sentinel recommends WAIT. This decision is made by code, not by the AI: the money is still in flight, so a second payment could pay the supplier twice."

**Do:** click **Run investigator**. Point at the findings and their evidence chips.

**Say:** "The AI investigator explains the decision. Every claim it makes is linked to a piece of evidence, and a verifier rejects anything it cannot back up. The AI can read and propose; it can never move money."

**Do:** click **Resend anyway**.

**Say:** "If a stressed operator clicks Resend anyway, policy blocks it, explains why, and records it in the audit log."

**Do:** point at the **Arrival and cost estimate** card.

**Say:** "On the side there is an advisory cost estimate, clearly labelled as illustrative. It agrees: waiting is cheapest, and a replacement is not even priced, because policy forbids it."

## 3. New evidence changes the decision (1:30 – 2:30)

**Do:** click **Original fails: bank return**, then **Re-evaluate**.

**Say:** "Now new evidence arrives: the beneficiary's bank returned the payment. On Airwallex a failed transfer turns into CANCELLED within seconds, and many systems lose the reason. Sentinel keeps it."

**Do:** point at **REPLACE**. Click **Run investigator** and point at "Changed from WAIT to REPLACE".

**Say:** "The recommendation changes to REPLACE, and Sentinel shows exactly what changed and why."

**Do:** sign out, sign in as the **APPROVER** (token from the same file, off-camera), open **Approval Center**.

**Say:** "A second person must approve. The approval is a signature over the exact amount, currency, beneficiary, evidence and provider state. If anything changes, the approval dies. And the person who proposed a payment can never approve it."

**Do:** **Approve and send**, confirm.

**Say:** "The executor re-checks everything with the provider, then sends the replacement with a brand-new request ID."

## 4. The same flow on the real Airwallex sandbox (2:30 – 3:30)

**Do:** switch to the second PowerShell window and run:

```bash
pnpm sandbox scenario-a
```

**Say:** "That was our simulator. This is the same product code against the real Airwallex sandbox. It creates a real sandbox transfer, moves it to SENT, decides WAIT, blocks the resend, simulates a bank return, decides REPLACE, gets a four-eyes approval, sends the replacement and follows it to PAID."

**Do:** let the steps scroll. Point at `BLOCKED`, then `REPLACE`, then the two different request IDs, then `RESOLVED` and `audit chain verified`.

**Say:** "The incident closes only after Sentinel records what happened to the original. The books are posted and the audit chain is verified."

**Do:** back in the browser, open **Incidents**, then the newest **Sandbox scenario** incident.

**Say:** "And here it is in the console: labelled sandbox, resolved, settled by the replacement, original returned by the bank."

## 5. Decision Replay (3:30 – 4:00)

**Do:** click **Decision Replay**, click the **Decision: REPLACE** step, then press **Play** for a few steps.

**Say:** "Decision Replay rebuilds every decision from the tamper-evident audit log: what was known, what was proposed, what was blocked, who approved, and why the decision changed."

## 6. Fraud, races, and proof (4:00 – 4:30)

**Do:** Scenario Lab → **Start in mock mode** on Scenario C.

**Say:** "Scenario C: an email claiming to be the supplier asks us to pay a new bank account and tries to give the AI instructions. Code catches it, payment is blocked, and only a person can clear it."

**Do:** Scenario Lab → Scenario B race button (if time allows).

**Say:** "Ten approvers and ten executors fire at once: one approval, one transfer."

**Say (closing):** "Behind this: 187 unit tests, 129 database tests, 14 browser tests, 33 attacks with none succeeding, and a TLA+ model checked over 1.4 million states, which found a real race that we then fixed. Quantum Sentinel: investigates payment problems, safely coordinates their resolution, and explains every financial decision."

---

## If something goes wrong while recording

- **The sandbox run stops or fails:** say "the sandbox is having a moment", and show the recorded run in `docs/SANDBOX-RUN.md` instead. Call it a *recorded sandbox run*, never live.
- **Over 5 minutes:** cut part 6 to the Scenario C sentence and the closing line.
- **Never** show the `.env` file, the tokens file, or the Airwallex web app's API keys page.
