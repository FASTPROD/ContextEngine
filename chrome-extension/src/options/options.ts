import { DEFAULT_CONFIG, type ExtensionConfig } from "../lib/types.js";

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) =>
  document.getElementById(id) as T;

const secret = $<HTMLInputElement>("secret");
const endpoint = $<HTMLInputElement>("endpoint");
const captureClaudeAi = $<HTMLInputElement>("captureClaudeAi");
const captureChatGptCom = $<HTMLInputElement>("captureChatGptCom");
const redactSecrets = $<HTMLInputElement>("redactSecrets");
const redactPii = $<HTMLInputElement>("redactPii");
const savedAt = $<HTMLElement>("savedAt");

async function load() {
  const stored = (await chrome.storage.local.get(DEFAULT_CONFIG)) as ExtensionConfig;
  secret.value = stored.secret || "";
  endpoint.value = stored.endpoint;
  captureClaudeAi.checked = stored.captureClaudeAi;
  captureChatGptCom.checked = stored.captureChatGptCom;
  redactSecrets.checked = stored.redactSecrets;
  redactPii.checked = stored.redactPii;
}

async function save() {
  const config: Partial<ExtensionConfig> = {
    secret: secret.value.trim() || null,
    endpoint: endpoint.value.trim() || DEFAULT_CONFIG.endpoint,
    captureClaudeAi: captureClaudeAi.checked,
    captureChatGptCom: captureChatGptCom.checked,
    redactSecrets: redactSecrets.checked,
    redactPii: redactPii.checked,
  };
  await chrome.storage.local.set(config);
  savedAt.textContent = `Saved at ${new Date().toLocaleTimeString()}.`;
  setTimeout(() => (savedAt.textContent = ""), 4_000);
}

$("save").addEventListener("click", save);
$("reveal").addEventListener("click", () => {
  secret.type = secret.type === "password" ? "text" : "password";
});

load();
