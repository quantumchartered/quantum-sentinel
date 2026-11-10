/* global sessionStorage -- runs inside the browser page */
// Screenshots of the real sandbox incident for the README and the demo (run with the API on :4000).
// Usage: node e2e/sandbox-shots.mjs <incidentId>. Reads sign-in tokens from .local/demo-tokens.json; prints none.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const id = process.argv[2];
const token = JSON.parse(readFileSync(fileURLToPath(new URL("../.local/demo-tokens.json", import.meta.url)), "utf8")).tokens.VIEWER;
const shot = (name) => fileURLToPath(new URL(`../docs/screenshots/${name}.png`, import.meta.url));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
await page.addInitScript((t) => sessionStorage.setItem("sentinel.token", t), token);
await page.goto(`http://127.0.0.1:4000/incidents/${id}`);
await page.getByRole("heading", { name: "Recommendation" }).waitFor();
await page.getByText("Airwallex sandbox", { exact: true }).waitFor();
await page.screenshot({ path: shot("20-sandbox-workspace-resolved") });
await page.goto(`http://127.0.0.1:4000/incidents/${id}/replay`);
await page.getByRole("button", { name: /Decision: REPLACE/ }).click();
await page.getByText("Decision changed: WAIT → REPLACE").waitFor();
await page.screenshot({ path: shot("21-sandbox-decision-replay") });
await browser.close();
console.log("saved 20-sandbox-workspace-resolved.png, 21-sandbox-decision-replay.png");
