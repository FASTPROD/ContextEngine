# VS Code Extension — Publishing Steps

> ✅ ALL STEPS COMPLETE — Extension published as `css-llc.contextengine` v0.4.0

## Overview

Publishing a VS Code extension requires **3 accounts + 1 CLI tool**. All completed Feb 22, 2026.

---

## Step 1: Create Azure DevOps Organization ✅

1. Go to https://dev.azure.com
2. Signed in with **personal** Microsoft account `ymolinier@hotmail.com` (NOT enterprise `@fastprod.onmicrosoft.com`)
3. Created organization: `css-llc` (name `CSS` was taken)
4. Created mandatory project `contextengine` (required before PAT access)

## Step 2: Generate a Personal Access Token (PAT) ✅

1. Direct URL: `https://dev.azure.com/css-llc/_usersSettings/tokens`
2. Created token with **Marketplace → Manage** scope, 1-year expiry
3. PAT stored securely

## Step 3: Create VS Code Marketplace Publisher ✅

1. Go to https://marketplace.visualstudio.com/manage
2. Created publisher `css-llc` with display name `CSS LLC`

## Step 4: Login with vsce CLI ✅

```bash
echo '<PAT>' | npx @vscode/vsce login css-llc
# Note: --pat flag does NOT exist, must pipe the token
```

## Step 5: Published ✅

- **v0.1.0** — Initial release (6 source files, git monitor, status bar, chat participant)
- **v0.2.0** — Added info panel WebView (7 source files, ℹ️ status bar icon, monitoring checklist)
- **v0.3.0** — BSL-1.1 license sync, PRO upgrade CTA in info panel, clickable PRO badges → pricing page
- **v0.4.0** — `/sync` command, doc staleness notifications, pre-commit hook, `contextengine.sync` command, event-driven CE compliance
- **Marketplace**: https://marketplace.visualstudio.com/items?itemName=css-llc.contextengine
- **Marketplace propagation**: Takes 5-15 minutes after publish before web page is live

---

## Status: ✅ PUBLISHED
