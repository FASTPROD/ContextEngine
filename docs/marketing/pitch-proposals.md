# OpsContext — Pitch proposals (EN + FR)

> Saved 2026-06-22 from Session 09 conversation. Multiple proposals for different surfaces (landing hero, Reddit/HN, tagline, enterprise sales deck). Pick one per channel; mix-and-match across them is fine.

The OpsContext "one true sentence" we're translating:
> *We're the only one with tamper-evident audit + policy + cross-surface capture + local-first.*

---

## English

### A. Pain-first  *(use on Reddit, Hacker News, dev-blog opener)*

> Your AI assistant is in your browser, your IDE, your terminal — but nothing watches it across all three. OpsContext does, with a tamper-proof log you can show an auditor and policy rules that actually block bad changes. Local-first, no API keys.

### B. Pillars-stacked  *(use as the landing-page hero paragraph)*

> The only AI-agent observability layer that captures every surface (browser + IDE + terminal), proves what happened (hash-chained audit log), and stops what shouldn't (policy-as-code hooks). Runs entirely on your machine.

### C. Punchy / short  *(use as the tagline under the logo)*

> Watch your AI everywhere. Prove what it did. Block what it shouldn't. Local-first.

### D. Enterprise-buyer  *(use on the sales-deck / DSI-pitch page)*

> AI agents touch your code through Claude.ai, Cursor, Copilot, and the terminal — four blind spots for your compliance team. OpsContext captures all four with a single tamper-evident log that produces evidence aligned with SOC 2 CC7.2 + ISO 27001 A.12.4.1 (evidence for *your* auditor — OpsContext itself is not certified), enforced by policy you author in version control, with zero data leaving your network.

---

## Français

### A. Pain-first  *(Reddit FR / LinkedIn / blog dev)*

> Ton assistant IA travaille dans ton navigateur, ton IDE, ton terminal — mais rien ne le surveille à travers les trois. OpsContext le fait, avec un journal infalsifiable que tu peux montrer à un auditeur et des règles de politique qui bloquent réellement les mauvaises modifications. 100 % local, sans clés API.

### B. Pillars-stacked  *(landing page — paragraphe héros)*

> La seule couche d'observabilité pour agents IA qui capture chaque surface (navigateur + IDE + terminal), prouve ce qui s'est passé (journal à chaînage cryptographique) et bloque ce qui ne devrait pas se faire (politiques exécutables). Tout reste sur ta machine.

### C. Punchy  *(tagline sous le logo)*

> Surveille ton IA partout. Prouve ce qu'elle a fait. Bloque ce qu'elle ne devrait pas. 100 % local.

### D. Enterprise FR  *(pitch DSI / direction des systèmes d'information)*

> Les agents IA modifient votre code via Claude.ai, Cursor, Copilot et le terminal — quatre angles morts pour votre conformité. OpsContext capture les quatre dans un journal infalsifiable unique produisant des éléments probants alignés sur SOC 2 CC7.2 et ISO 27001 A.12.4.1 (éléments probants pour *votre* auditeur — OpsContext lui-même n'est pas certifié), appliqué par des politiques versionnées dans Git, et sans qu'aucune donnée ne quitte votre réseau.

---

## Recommended mapping (per surface)

| Surface | EN | FR |
|---|---|---|
| Landing page hero (compr.fr) | **B** | **B** |
| Tagline under logo | **C** | **C** |
| Reddit / Hacker News / dev blog | **A** | **A** |
| Enterprise sales deck / DSI brief | **D** | **D** |
| npm package description (140 char) | C (truncated) | C (truncated) |
| VS Code Marketplace short description | B (compressed) | — (Marketplace is anglophone) |

---

## Vocabulary glossary (for keeping French copy precise)

- **Tamper-evident audit log** → *journal infalsifiable* (literal: "uncountfeitable log") — captures both the cryptographic and the legal meaning
- **Hash-chained** → *à chaînage cryptographique* — "chained via cryptography"
- **Cross-surface capture** → *capture multi-surfaces* or *capture à travers tous les outils*
- **Policy-as-code** → *politiques exécutables* (literal: "executable policies") or *politiques-en-tant-que-code* (more literal but heavier)
- **Local-first** → *100 % local* (most readable) or *priorité au local* (technical)
- **Compliance team** → *équipe conformité* — drop "team" when it sounds heavy
- **SOC 2** → keep as **SOC 2** (with space; the standard is recognized in French regulatory writing)
- **Audit log** → *journal d'audit* (formal) or just *journal* if context is clear
- **Drift detection** → *détection de dérive* — works in both French AI/MLOps writing

---

## What NOT to write (anti-patterns)

- ❌ **"Cheaper than Helicone / Langfuse"** — competing on price puts you in a race you can't win; their teams outspend you on marketing
- ❌ **"AI orchestration platform"** — generic, sounds like LangChain
- ❌ **"AI memory layer"** — sounds like Mem0
- ❌ **"Vector RAG database"** — sounds like Pinecone
- ❌ **"For Claude Code users"** — too narrow; you also serve Cursor / Windsurf / Copilot / browser users
- ❌ **"MCP server"** — true but uninteresting to a buyer; that's an implementation detail

Lead with the **pain** and the **unique combination** (audit + policy + cross-surface + local-first). The npm/MCP detail comes later in the page, not in the hero.
