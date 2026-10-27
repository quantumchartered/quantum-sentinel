# Sandbox and coding-agent setup

Status recorded October 27, 2026 (Codex), updated the same day by Claude Code. This is setup documentation; no application exists yet.

## Connection status

| Component | Verified state |
| --- | --- |
| Codex Docs MCP | `airwallex_docs` registered and enabled at `https://mcp.sandbox.airwallex.com/docs`; initialization, tool listing, and documentation search succeeded; tools subsequently became available in this chat |
| Codex Developer MCP | `airwallex_dev` registered and enabled at `https://mcp.sandbox.airwallex.com/developer`; OAuth launched but timed out waiting for the user's callback; account access not verified |
| Global Accounts verification | Not run: Developer OAuth or REST credentials required; an empty authenticated list will count as success |
| Claude Code (desktop app) | Running since Oct 27. Project `.mcp.json` loaded. `airwallex-docs` connected and searched successfully. `airwallex-dev` **needs sandbox login**: run `/mcp` in Claude Code and authenticate `airwallex-dev` |
| Runtime | Node v24.20.0; pnpm 12.15.0 installed globally (`npm i -g pnpm@12.15.0`); `pnpm check` green |
| Docker | Compose v5.5.1 and engine 29.7.2 verified; no containers created |
| TLC runtime | Java not found on PATH; use a pinned Java/TLC container or install an approved runtime in the formal-model phase |

The public Docs MCP search returned both current and legacy material. Successful connectivity is not proof that an endpoint payload matches the selected API version. See [API research](API-RESEARCH.md).

## Finish the sandbox login

In a local terminal, run:

```powershell
codex mcp login airwallex_dev
```

Complete the browser login with an Airwallex **sandbox** account. If the callback expires, start a fresh login; do not copy OAuth tokens or callback codes into the repository. Restart the MCP server in the app if its tools do not appear. Then ask the coding agent to list Global Accounts. Record success only after that authenticated read returns, including an empty list.

The commands are supported by the installed Codex CLI help and [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Configuration is shared by Codex desktop and CLI. The developer-lab snippet includes an old experimental client flag; this installed client supports HTTP directly, so no experimental flag was added.

If reconstructing setup on another machine, use:

```powershell
codex mcp add airwallex_docs --url https://mcp.sandbox.airwallex.com/docs
codex mcp add airwallex_dev --url https://mcp.sandbox.airwallex.com/developer
```

These only configure the requested sandbox/documentation services. This project does not configure AgentOS.

## Claude handoff

`AGENTS.md` and `CLAUDE.md` are identical copies of the pasted user rules. `.mcp.json` contains only the two public server URLs and HTTP transport settings. No credentials are stored there.

The [developer lab](https://airwallexdev.com) supplies these CLI snippets. In a Claude Code environment without the project configuration already loaded:

```sh
claude mcp add-json airwallex-docs '{ "type": "http", "url": "https://mcp.sandbox.airwallex.com/docs" }'
claude mcp add-json airwallex-dev '{ "type": "http", "url": "https://mcp.sandbox.airwallex.com/developer" }'
```

Use either the project entries or CLI registration; inspect existing entries before adding duplicates. Complete that client's sandbox login and verify a read. The missing local Claude executable has not been installed as part of Phase 0.

## Create an account and place application secrets

1. Create/login to your account at [Airwallex Sandbox](https://sandbox.airwallex.com). The developer lab says additional businesses should use `Sandbox Business` or `New Business Sandbox` for automatic sandbox onboarding. Verify the actual account is approved.
2. Open **Account → Developer → API keys**. Create a sandbox API key with the minimum permissions required for balances, Global Accounts, beneficiaries, transfers, and sandbox simulation. Exact permission labels will be checked in the account UI; do not substitute a production key.
3. From the project root, create `.env` if absent using the command in README.md. Put the Client ID in `AIRWALLEX_CLIENT_ID` and the key in `AIRWALLEX_API_KEY`. Keep the base URL at `https://api.sandbox.airwallex.com`. Do not paste keys into chat.
4. During Phase 1, create the webhook subscription in the sandbox developer settings after the verified receiver and tunnel exist. Set the agreed API version and relevant transfer lifecycle events, including `payout.transfer.paid`, `.failed`, and `.cancelled`. Store the subscription secret in `AIRWALLEX_WEBHOOK_SECRET`.
5. During the LLM phase, put an Anthropic API key in `ANTHROPIC_API_KEY`; select a supported Claude model in `ANTHROPIC_MODEL`. Generate independent local approval/session secrets directly into `.env` then. Never use the provider API key as an HMAC secret.

Account/API-key instructions are from the [developer lab](https://airwallexdev.com). Subscription/signature configuration follows [official webhook documentation](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events).

Application secrets belong in ignored `.env`. MCP OAuth is handled separately by the coding client's credential store; do not extract it into application files. `.env.example` contains empty secret placeholders and is safe to commit. No actual `.env` was created or read during Phase 0.

## First authenticated checks after Phase 0 approval

Before mutations, verify REST authentication and returned token expiry; selected API version; Global Accounts; available cash balance; and required scopes. Retrieve the beneficiary schema for the selected USD/local corridor before constructing any bank payload.

If no suitable Global Account exists, the guide directs creation through REST, then simulated funding. Use the account's country (`US` for the planned initial account), not a currency code. Verify endpoint schemas and retry behavior first. The guide's assertions about Developer MCP creation limits, rejected BE accounts, and immediate deposit availability have not been tested against this account. No funding operation is authorized by Phase 0 itself.

If Developer MCP login cannot be completed, the documented fallback is Docs MCP plus direct sandbox REST using `.env` credentials. Record the limitation; never fabricate a successful connection or demo response.
