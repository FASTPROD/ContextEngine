# VS Code Extension — Publishing Steps

> What YOU (Yannick) need to do before we can publish

## Overview

Publishing a VS Code extension requires **3 accounts + 1 CLI tool**. Here's exactly what you need to set up. I can build the extension code, but these accounts require your identity.

---

## Step 1: Create Azure DevOps Organization (5 min)

1. Go to https://dev.azure.com
2. Sign in with your Microsoft account (or create one with `yannick@compr.ch`)
3. Create a new organization: `CSS`
4. That's it — you just need the org to exist

## Step 2: Generate a Personal Access Token (PAT) (3 min)

1. In Azure DevOps, click your profile icon → **Personal Access Tokens**
2. Click **+ New Token**
3. Settings:
   - **Name**: `vsce-contextengine`
   - **Organization**: `CSS`
   - **Expiration**: 1 year (max)
   - **Scopes**: Click **Custom defined**, then:
     - Find **Marketplace** → check **Manage**
4. Click **Create** → **copy the token immediately** (you won't see it again)
5. Save it securely (1Password, etc.)

## Step 3: Create VS Code Marketplace Publisher (3 min)

1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with the same Microsoft account
3. Click **Create Publisher**
4. Settings:
   - **Publisher ID**: `css-llc` (lowercase, this appears in extension IDs like `css-llc.contextengine`)
   - **Display Name**: `CSS LLC`
   - **Email**: `yannick@compr.ch`
5. Click **Create**

## Step 4: Login with vsce CLI (2 min)

I'll handle installing `vsce` globally. You just need to run:

```bash
npx @vscode/vsce login css-llc
```

Paste your PAT when prompted. Done.

## Step 5: I Build & Publish

Once you've done Steps 1-4, I can:
1. Create the extension manifest (`package.json` with VS Code extension fields)
2. Bundle the MCP server as a VS Code extension
3. Package with `vsce package` → creates `.vsix`
4. Publish with `vsce publish` → live on marketplace

---

## What the Extension Will Look Like

```
Extension ID: css-llc.contextengine
Display Name: ContextEngine — AI Agent Compliance
Description: Durable memory and enforcement for AI coding agents.
             Agents forget context, skip commits, and lose work.
             ContextEngine monitors, reminds, and enforces protocol
             — so your AI sessions end clean, not chaotic.
Category: AI
Tags: mcp, ai, agent, enforcement, compliance, memory, session, copilot, cursor, claude
```

## Alternative: Publish to Open VSX (Eclipse Foundation)

If you also want to reach non-Microsoft VS Code forks (VSCodium, Gitpod, etc.):

1. Go to https://open-vsx.org
2. Sign in with GitHub (`FASTPROD`)
3. Create namespace `css-llc`
4. Generate access token
5. I publish with `npx ovsx publish`

---

## Timeline

| Step | Who | Time |
|------|-----|------|
| Azure DevOps org | You | 5 min |
| PAT generation | You | 3 min |
| Publisher creation | You | 3 min |
| Extension code | Me | ~2 hours |
| Package + publish | Me | 5 min |
| **Total** | | **~2.5 hours** |

---

## Status: 🟡 WAITING ON YOU

When you're ready, do Steps 1-3 and give me the **publisher ID** and confirm the PAT is created. I'll handle everything else.
