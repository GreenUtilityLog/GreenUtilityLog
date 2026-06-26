# AI tooling for Green Utility Log

Two separate things, don't mix them up:
1. **VeChain AI dev tools** — give a coding agent (Claude Code / Cursor) direct access
   to the VeChain testnet so it can read the chain, check balances, the rewards pool,
   leaderboards, and decode events itself. *For building & debugging.*
2. **Marketing assistant** — a human-in-the-loop workflow where the agent drafts posts
   and replies, **you approve and post**. *Not* an autonomous bot. *For growth.*

---

## 1. VeChain AI dev tools

### a) VeChain MCP server (already wired up — `.mcp.json`)

The repo now ships a project-scoped MCP config at `.mcp.json`:

```json
{
  "mcpServers": {
    "vechain": {
      "command": "npx",
      "args": ["-y", "@vechain/mcp-server@latest"],
      "env": { "VECHAIN_NETWORK": "testnet" }
    }
  }
}
```

When you open this project in Claude Code (or Cursor), it will ask to enable the
**vechain** MCP server. Approve it once. After that the agent can, on **testnet**:

- look up any account's **B3TR / VET / VTHO balance** (e.g. confirm your wallet holds
  test-B3TR before funding the pool — the exact thing we checked by hand)
- read the **X2EarnRewardsPool** state, blocks, transactions, and **decode events**
  into human-readable form
- pull **VeBetterDAO / B3TR leaderboards** and proposal/voting data
- search VeChain / VeChain Kit / VeBetterDAO **docs**

**Why this matters for us:** the empty-pool and wrong-distributor debugging we did
manually (you checking VeWorld + the explorer) becomes something the agent does itself —
"is the pool funded? does 0x3a00 hold B3TR? did that reward tx revert?" answered directly.

> Note: it runs via `npx`, so the machine needs npm + network access to npmjs the first
> time. In a locked-down/offline environment it won't fetch; run it where outbound npm
> is allowed (your local Claude Code is ideal).

### b) VeBetterDAO skill (recommended, optional)

`vechain/vechain-ai-skills` ships skills for coding agents, including a **`vebetterdao`**
skill covering exactly our domain: X2Earn apps, B3TR/VOT3, reward distribution,
sustainability proofs, app submission, governance. Add it to Claude Code with the skills
marketplace/installer per that repo's README (https://github.com/vechain/vechain-ai-skills).
It teaches the agent the VeBetterDAO conventions so future contract/reward work is more
accurate.

### What does NOT exist yet (don't build on it)

VeChain's 2026 roadmap (Agent Marketplace, AgentSuite / AgentForge / AgentMarket /
AgentTrust, MCP On-Chain, Agent Indexer, SDK v3) is **future** — a vision of hireable
on-chain agents, not shippable tooling today. Fine to mention as "where the ecosystem is
heading"; do not depend on it for the beta or launch.

---

## 2. Marketing assistant (human-in-the-loop)

**Principle:** automate the *drafting*, never the *posting*. Fully automated crypto
social activity reads as botting and repels the genuine beta testers you actually want.
You stay the human voice; the agent removes the blank-page tax.

### The weekly loop (15 min, with the agent)

1. **Monday — plan & draft.** Tell the agent what changed last week and what's next. It
   produces the week's posts from `MARKETING.md` (build-in-public update, a feature
   explainer, a poll, a tester shout-out). You edit tone, you post.
2. **Daily — reply drafting.** Paste a comment/question you got; the agent drafts a
   short, on-brand reply. You send it (in your words). First-hour replies matter most.
3. **Friday — recap.** Agent turns the week's tester feedback (bugs/ideas) into a short
   "here's what you said, here's what we're fixing" post — the highest-trust content you
   can publish during a beta.

### Telegram FAQ helper (optional, safe automation)

The *one* place light automation is fine: a Telegram bot that answers repeated setup
questions (it's information, not engagement-faking). Set it up via **@BotFather**, then a
simple command/keyword bot that replies to:

- `/start` / "how do I start" → the pinned 5-step onboarding
- "testnet" / "network" → how to switch VeWorld to testnet
- "vtho" / "gas" / "faucet" → where to get free testnet VTHO
- "no b3tr" / "balance" → claim test-B3TR / the faucet button in-app
- "scam" / "support" → "admins never DM first, never share your seed phrase"

Keep human conversation human; let the bot only handle the FAQ. (A no-code builder like
Manybot, or a tiny grammY/Telegraf script, is enough — ask me to generate it when you
want it.)

### Guardrails (put these in your own head, and the group pin)
- Never promise a mainnet date or token price.
- Always label testnet / "test-B3TR, no monetary value".
- "Admins never DM first. We never ask for your seed phrase."
- You — not a bot — reply to real humans.
