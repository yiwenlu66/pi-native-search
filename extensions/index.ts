/**
 * Pi Search Extension
 *
 * Adds web_search, web_fetch, and image_generate tools to pi.
 * Uses the current provider's native web search API when available
 * (ZAI, Google, OpenAI, xAI, Anthropic), falls back to DuckDuckGo otherwise.
 * ZAI search uses the Web Search Prime MCP endpoint (included in
 * Coding Plans) rather than the separate paid Web Search API.
 *
 * Usage:
 *   /search          - Toggle search tools on/off (only shows configured providers)
 *   /search providers - Show ALL providers and their capabilities
 *   /search config    - Show current config
 *   /search on|off    - Quick toggle
 *
 * Config persists in ~/.pi/agent/search-config.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
  type SelectItem,
  SelectList,
} from "@earendil-works/pi-tui";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";

interface SearchConfig {
  enabled: boolean;
  searchEnabled: boolean;
  fetchEnabled: boolean;
  imageEnabled: boolean;
  providerOverrides: Record<
    string,
    { searchEnabled?: boolean; fetchEnabled?: boolean }
  >;
}

const PROVIDERS: Record<
  string,
  {
    name: string;
    nativeSearch: boolean;
    nativeFetch: boolean;
    envKey: string;
  }
> = {
  zai: {
    name: "ZAI (GLM)",
    nativeSearch: true,
    nativeFetch: true,
    envKey: "ZAI_API_KEY",
  },
  google: {
    name: "Google Gemini",
    nativeSearch: true,
    nativeFetch: false,
    envKey: "GEMINI_API_KEY",
  },
  openai: {
    name: "OpenAI",
    nativeSearch: true,
    nativeFetch: false,
    envKey: "OPENAI_API_KEY",
  },
  xai: {
    name: "xAI (Grok)",
    nativeSearch: true,
    nativeFetch: false,
    envKey: "XAI_API_KEY",
  },
  anthropic: {
    name: "Anthropic",
    nativeSearch: true,
    nativeFetch: false,
    envKey: "ANTHROPIC_API_KEY",
  },
  "claude-bridge": {
    name: "Claude Code (subscription)",
    nativeSearch: true,
    nativeFetch: true,
    envKey: "",
  },
  openrouter: {
    name: "OpenRouter",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "OPENROUTER_API_KEY",
  },
  deepseek: {
    name: "DeepSeek",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "DEEPSEEK_API_KEY",
  },
  mistral: {
    name: "Mistral",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "MISTRAL_API_KEY",
  },
  groq: {
    name: "Groq",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "GROQ_API_KEY",
  },
  cerebras: {
    name: "Cerebras",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "CEREBRAS_API_KEY",
  },
  huggingface: {
    name: "Hugging Face",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "HF_TOKEN",
  },
  fireworks: {
    name: "Fireworks",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "FIREWORKS_API_KEY",
  },
  cloudflare: {
    name: "Cloudflare",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "",
  },
  "amazon-bedrock": {
    name: "Amazon Bedrock",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "",
  },
  "azure-openai": {
    name: "Azure OpenAI",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "",
  },
  kimi: {
    name: "Kimi",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "KIMI_API_KEY",
  },
  minimax: {
    name: "MiniMax",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "MINIMAX_API_KEY",
  },
  "github-copilot": {
    name: "GitHub Copilot",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "",
  },
  vercel: {
    name: "Vercel AI Gateway",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "AI_GATEWAY_API_KEY",
  },
  opencode: {
    name: "OpenCode",
    nativeSearch: false,
    nativeFetch: false,
    envKey: "OPENCODE_API_KEY",
  },
};

// ─── Config ──────────────────────────────────────────────────────────────────

function getConfigPath() {
  return join(getAgentDir(), "search-config.json");
}

function defaultConfig(): SearchConfig {
  return {
    enabled: true,
    searchEnabled: true,
    fetchEnabled: true,
    imageEnabled: true,
    providerOverrides: {},
  };
}

function loadConfig(): SearchConfig {
  const defaults = defaultConfig();
  try {
    const path = getConfigPath();
    if (existsSync(path)) return { ...defaults, ...JSON.parse(readFileSync(path, "utf-8")) };
  } catch {}
  return defaults;
}

function saveConfig(config: SearchConfig) {
  const dir = getAgentDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

// ─── API Key ──────────────────────────────────────────────────────────────────

function getApiKey(provider: string): string | undefined {
  const cap = PROVIDERS[provider];
  if (!cap?.envKey) return undefined;
  const key = process.env[cap.envKey];
  if (key) return key;
  try {
    const authPath = join(getAgentDir(), "auth.json");
    if (existsSync(authPath)) {
      const entry = JSON.parse(readFileSync(authPath, "utf-8"))[provider];
      if (entry?.type === "api_key" && entry.key && !entry.key.startsWith("!"))
        return entry.key;
    }
  } catch {}
  return undefined;
}

/** Check if a provider has credentials configured */
function hasCredentials(provider: string): boolean {
  // claude-bridge uses the `claude` CLI's own subscription auth — assume it's
  // available if the user has selected this provider in pi.
  if (provider === "claude-bridge") return true;
  if (getApiKey(provider)) return true;
  try {
    const authPath = join(getAgentDir(), "auth.json");
    if (existsSync(authPath)) {
      const entry = JSON.parse(readFileSync(authPath, "utf-8"))[provider];
      if (entry?.type === "oauth" && entry.refresh) return true;
    }
  } catch {}
  return false;
}

// ─── ZAI MCP Web Search ──────────────────────────────────────────────────────

const ZAI_MCP_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";

interface McpSession {
  sessionId: string;
}

async function mcpInit(apiKey: string, signal?: AbortSignal): Promise<McpSession> {
  const res = await fetch(ZAI_MCP_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "pi-search", version: "0.1.0" },
      },
    }),
  });
  if (!res.ok)
    throw new Error(`ZAI MCP init ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const sessionId = res.headers.get("Mcp-Session-Id");
  if (!sessionId) throw new Error("ZAI MCP: no session ID returned");
  return { sessionId };
}

async function mcpCall<T = any>(
  session: McpSession,
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
  id: number,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(ZAI_MCP_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": session.sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok)
    throw new Error(
      `ZAI MCP ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const text = await res.text();
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const json = JSON.parse(line.slice(5).trim());
      if (json.error) throw new Error(`ZAI MCP: ${json.error.message}`);
      return json.result as T;
    }
  }
  throw new Error("ZAI MCP: no data in response");
}

async function zaiSearch(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const session = await mcpInit(apiKey, signal);
  const result = (await mcpCall(
    session,
    apiKey,
    "tools/call",
    {
      name: "web_search_prime",
      arguments: { search_query: query },
    },
    2,
    signal,
  )) as any;

  const content = result?.content?.[0]?.text;
  if (!content) return "No results found.";

  let parsed: unknown = content;
  for (let i = 0; i < 3; i++) {
    if (typeof parsed !== "string") break;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }

  if (!Array.isArray(parsed))
    return typeof parsed === "string" ? parsed : "No results found.";

  const results = parsed as {
    title: string;
    link: string;
    content: string;
    refer: string;
  }[];
  if (!results.length) return "No results found.";

  const parts: string[] = [];
  for (let i = 0; i < Math.min(results.length, 8); i++) {
    const r = results[i]!;
    parts.push(`${i + 1}. **${r.title}**\n   ${r.link}\n   ${r.content}`);
  }
  return parts.join("\n\n");
}

// ─── Anthropic Web Search ─────────────────────────────────────────────────────

async function anthropicSearch(
  query: string,
  model: string,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/v1/messages`
    : "https://api.anthropic.com/v1/messages";
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!res.ok)
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;

  const parts: string[] = [];
  const sources: { title: string; url: string }[] = [];

  for (const block of data.content || []) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "web_search_tool_result") {
      for (const result of block.content || []) {
        if (result.type === "web_search_result") {
          sources.push({ title: result.title || "", url: result.url || "" });
        }
      }
    } else if (block.type === "text" && block.citations) {
      for (const cit of block.citations || []) {
        if (cit.type === "web_search_result_location") {
          sources.push({ title: cit.title || "", url: cit.url || "" });
        }
      }
    }
  }

  if (sources.length) {
    parts.push("\n## Sources:");
    for (const s of sources.slice(0, 8)) parts.push(`- [${s.title}](${s.url})`);
  }

  return parts.join("\n") || "No results found.";
}

// ─── Other Native Search ─────────────────────────────────────────────────────

async function googleSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
    },
  );
  if (!res.ok)
    throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const parts: string[] = [];
  const c = data.candidates?.[0];
  if (c?.content?.parts?.[0]?.text) parts.push(c.content.parts[0].text);
  if (c?.groundingMetadata?.groundingChunks) {
    parts.push("\n## Sources:");
    for (const ch of c.groundingMetadata.groundingChunks.slice(0, 8))
      if (ch.web) parts.push(`- [${ch.web.title}](${ch.web.uri})`);
  }
  return parts.join("\n") || "No results found.";
}

async function openaiSearch(
  query: string,
  model: string,
  apiKey: string,
  baseUrl = "https://api.openai.com/v1",
  signal?: AbortSignal,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search" }],
      input: query,
    }),
  });
  if (!res.ok)
    throw new Error(`OpenAI Responses ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const parts: string[] = [];
  for (const item of data.output || []) {
    if (item.type === "message" && item.content?.[0]?.text) {
      parts.push(item.content[0].text);
      const urls =
        item.content[0].annotations
          ?.filter((a: any) => a.type === "url_citation")
          .map((a: any) => `- [${a.title}](${a.url})`) || [];
      if (urls.length) {
        parts.push("\n## Sources:");
        parts.push(...urls.slice(0, 8));
      }
    }
  }
  return parts.join("\n") || "No results found.";
}

async function xaiSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search" }],
      input: query,
    }),
  });
  if (!res.ok)
    throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const parts: string[] = [];
  for (const item of data.output || [])
    if (item.type === "message" && item.content?.[0]?.text)
      parts.push(item.content[0].text);
  if (data.citations?.length) {
    parts.push("\n## Sources:");
    for (const c of data.citations.slice(0, 8)) parts.push(`- ${c}`);
  }
  return parts.join("\n") || "No results found.";
}

// ─── Claude Code (via claude-agent-sdk) ─────────────────────────────────────
//
// Delegates web_search to a one-shot Claude Code query with WebSearch enabled.
// Reuses the SDK that ships inside pi-claude-bridge so we don't need a separate
// install. Auth comes from the `claude` CLI's own subscription credentials.

let cachedSdkModule: any = null;

async function loadClaudeAgentSdk(): Promise<any> {
  if (cachedSdkModule) return cachedSdkModule;
  const candidates = [
    // Windows global npm
    join(
      homedir(),
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "pi-claude-bridge",
      "package.json",
    ),
    // Unix global npm
    "/usr/local/lib/node_modules/pi-claude-bridge/package.json",
    "/usr/lib/node_modules/pi-claude-bridge/package.json",
    join(
      homedir(),
      ".npm-global",
      "lib",
      "node_modules",
      "pi-claude-bridge",
      "package.json",
    ),
    // Pi's own extensions dir if user installed locally
    join(getAgentDir(), "extensions", "pi-claude-bridge", "package.json"),
  ];
  for (const cand of candidates) {
    if (!existsSync(cand)) continue;
    try {
      const req = createRequire(cand);
      const sdkPath = req.resolve("@anthropic-ai/claude-agent-sdk");
      cachedSdkModule = await import(pathToFileURL(sdkPath).href);
      return cachedSdkModule;
    } catch {}
  }
  throw new Error(
    "Could not locate @anthropic-ai/claude-agent-sdk. Is pi-claude-bridge installed?",
  );
}

async function claudeBridgeSearch(
  query: string,
  signal?: AbortSignal,
): Promise<string> {
  const sdk = await loadClaudeAgentSdk();
  const sdkQuery = sdk.query({
    prompt:
      `Search the web for: ${query}\n\n` +
      "Use the WebSearch tool. Report results as a numbered list with title, " +
      "URL, and a brief snippet from each result. Do not add commentary beyond " +
      "what the search returned.",
    options: {
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      allowedTools: ["WebSearch"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [],
    },
  });

  const onAbort = () => {
    sdkQuery.interrupt().catch(() => {});
    try {
      sdkQuery.close();
    } catch {}
  };
  if (signal?.aborted) {
    onAbort();
    throw new Error("Aborted");
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  let responseText = "";
  try {
    for await (const message of sdkQuery) {
      if (signal?.aborted) break;
      if (
        message.type === "result" &&
        message.subtype === "success" &&
        message.result
      ) {
        responseText = message.result;
      }
    }
    return responseText || "No results found.";
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      sdkQuery.close();
    } catch {}
  }
}

async function claudeBridgeFetch(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const sdk = await loadClaudeAgentSdk();
  const sdkQuery = sdk.query({
    prompt:
      `Fetch this URL: ${url}\n\n` +
      "Use the WebFetch tool. Return the page's main content as plain " +
      "text or markdown. Do not summarise. Do not add commentary.",
    options: {
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      allowedTools: ["WebFetch"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [],
    },
  });

  const onAbort = () => {
    sdkQuery.interrupt().catch(() => {});
    try {
      sdkQuery.close();
    } catch {}
  };
  if (signal?.aborted) {
    onAbort();
    throw new Error("Aborted");
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  let responseText = "";
  try {
    for await (const message of sdkQuery) {
      if (signal?.aborted) break;
      if (
        message.type === "result" &&
        message.subtype === "success" &&
        message.result
      ) {
        responseText = message.result;
      }
    }
    return responseText || "No content returned.";
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      sdkQuery.close();
    } catch {}
  }
}

// ─── DuckDuckGo Fallback ─────────────────────────────────────────────────────

function extractDdgUrl(raw: string): string {
  const uddg = raw.match(/[?&]uddg=([^&]+)/)?.[1];
  if (uddg) {
    try {
      return decodeURIComponent(uddg);
    } catch {}
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

async function ddgSearch(query: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PiSearch/1.0)" },
    },
  );
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();
  const titles: { url: string; title: string }[] = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  const tr = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = tr.exec(html)) && titles.length < 8)
    titles.push({
      url: extractDdgUrl(m[1]!),
      title: m[2]!.replace(/<[^>]+>/g, "").trim(),
    });
  const sr = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = sr.exec(html)) && snippets.length < 8)
    snippets.push(m[1]!.replace(/<[^>]+>/g, "").trim());
  const results: string[] = [];
  for (let i = 0; i < titles.length; i++) {
    results.push(
      `${i + 1}. **${titles[i]!.title}**\n   ${titles[i]!.url}${snippets[i] ? `\n   ${snippets[i]}` : ""}`,
    );
  }
  return results.join("\n\n") || `No results found for "${query}".`;
}

// ─── Web Fetch ────────────────────────────────────────────────────────────────

async function httpFetch(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PiSearch/1.0)",
      Accept: "text/html,text/plain,application/json",
    },
  });
  if (!res.ok) throw new Error(`Fetch ${res.status} ${res.statusText}`);
  const ct = res.headers.get("content-type") || "";
  let text = ct.includes("application/json")
    ? JSON.stringify(await res.json(), null, 2)
    : await res.text();
  if (ct.includes("text/html"))
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const t = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  return (
    t.content +
    (t.truncated ? `\n\n[Truncated: ${t.outputLines}/${t.totalLines} lines]` : "")
  );
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function getResolvedApiKey(
  ctx: ExtensionContext,
  provider: string,
): Promise<string | undefined> {
  return (await ctx.modelRegistry.getApiKeyForProvider(provider)) ?? getApiKey(provider);
}

function isOpenAIResponsesCompatible(ctx: ExtensionContext, provider: string) {
  return (
    provider === "openai" ||
    provider === "openai-codex" ||
    ctx.model?.api === "openai-responses" ||
    ctx.model?.api === "openai-codex-responses"
  );
}

function isAnthropicCompatible(ctx: ExtensionContext, provider: string) {
  return (
    provider === "anthropic" ||
    (ctx.model as any)?.api === "anthropic-messages"
  );
}

async function doSearch(
  ctx: ExtensionContext,
  query: string,
  provider: string,
  model: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ text: string; nativeError?: string }> {
  const apiKey = await getResolvedApiKey(ctx, provider);
  const cap = PROVIDERS[provider];
  const isOpenAIResponses = isOpenAIResponsesCompatible(ctx, provider);
  const isAnthropic = isAnthropicCompatible(ctx, provider);
  const hasNativeSearch = !!cap?.nativeSearch || isOpenAIResponses || isAnthropic;
  // claude-bridge uses the `claude` CLI's own subscription auth, so it doesn't
  // need an api_key in pi's auth.json.
  const hasAuth = !!apiKey || provider === "claude-bridge";
  if (hasNativeSearch && hasAuth) {
    try {
      if (isOpenAIResponses) {
        return { text: await openaiSearch(query, model, apiKey!, baseUrl, signal) };
      }
      if (isAnthropic && provider !== "anthropic") {
        // Custom provider using anthropic-messages API (e.g. proxy)
        return {
          text: await anthropicSearch(query, model, apiKey!, baseUrl, signal),
        };
      }
      switch (provider) {
        case "zai":
          return { text: await zaiSearch(query, apiKey!, signal) };
        case "google":
          return { text: await googleSearch(query, model, apiKey!, signal) };
        case "xai":
          return { text: await xaiSearch(query, model, apiKey!, signal) };
        case "anthropic":
          return {
            text: await anthropicSearch(query, model, apiKey!, baseUrl, signal),
          };
        case "claude-bridge":
          return { text: await claudeBridgeSearch(query, signal) };
      }
    } catch (err: any) {
      return { text: await ddgSearch(query, signal), nativeError: err.message };
    }
  }
  return { text: await ddgSearch(query, signal) };
}

// ─── OpenAI Responses Image Generation ───────────────────────────────────────

interface ImageGenerateParams {
  prompt: string;
  referenceImages?: string[];
  outputPath?: string;
  action?: "auto" | "generate" | "edit";
  size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
  quality?: "low" | "medium" | "high" | "auto";
  outputFormat?: "png" | "webp" | "jpeg";
  inputFidelity?: "low" | "high";
  imageModel?: string;
}

function mimeFromPath(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function imageUrlFromReference(reference: string, cwd: string) {
  if (/^(https?:|data:)/i.test(reference)) return reference;
  const path = isAbsolute(reference) ? reference : resolve(cwd, reference);
  const bytes = readFileSync(path);
  return `data:${mimeFromPath(path)};base64,${bytes.toString("base64")}`;
}

function defaultImageOutputPath(cwd: string, format: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(cwd, `generated-image-${stamp}.${format === "jpeg" ? "jpg" : format}`);
}

function extractImageResult(data: any): string | undefined {
  for (const item of data.output || []) {
    if (item.type === "image_generation_call" && item.result) return item.result;
  }
  return undefined;
}

function extractImageResultDeep(data: any): string | undefined {
  const stack = [data];
  while (stack.length) {
    const item = stack.pop();
    if (!item) continue;
    if (Array.isArray(item)) {
      stack.push(...item);
      continue;
    }
    if (typeof item !== "object") continue;
    if (item.type === "image_generation_call" && typeof item.result === "string") {
      return item.result;
    }
    stack.push(...Object.values(item));
  }
  return undefined;
}

function codexBase64UrlDecode(data: string) {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf-8");
}

function extractCodexAccountId(token: string) {
  try {
    const [, payload] = token.split(".");
    if (!payload) throw new Error("missing JWT payload");
    const claims = JSON.parse(codexBase64UrlDecode(payload));
    const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!accountId) throw new Error("missing chatgpt_account_id claim");
    return accountId as string;
  } catch {
    throw new Error("Failed to extract OpenAI Codex account ID from OAuth token");
  }
}

function resolveCodexResponsesUrl(baseUrl: string) {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : "https://chatgpt.com/backend-api";
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

async function extractCodexImageResult(res: Response): Promise<string | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let splitAt = buffer.indexOf("\n\n");
      while (splitAt !== -1) {
        const event = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (data && data !== "[DONE]") {
          const parsed = JSON.parse(data);
          if (parsed.type === "error") {
            throw new Error(`OpenAI Codex image error: ${parsed.message || JSON.stringify(parsed)}`);
          }
          if (parsed.type === "response.failed") {
            const message = parsed.response?.error?.message || JSON.stringify(parsed.response?.error ?? parsed);
            throw new Error(`OpenAI Codex image failed: ${message}`);
          }
          const imageBase64 = extractImageResultDeep(parsed);
          if (imageBase64) return imageBase64;
        }
        splitAt = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
  return undefined;
}

function isOpenAICodexCompatible(ctx: ExtensionContext, provider: string) {
  return provider === "openai-codex" || ctx.model?.api === "openai-codex-responses";
}

function buildImageInputContent(params: ImageGenerateParams, cwd: string) {
  const content: any[] = [{ type: "input_text", text: params.prompt }];
  for (const reference of params.referenceImages ?? []) {
    content.push({
      type: "input_image",
      image_url: imageUrlFromReference(reference, cwd),
      detail: "auto",
    });
  }
  return content;
}

function buildImageGenerationTool(params: ImageGenerateParams, outputFormat: string) {
  const tool: any = {
    type: "image_generation",
    action: params.action ?? "auto",
    size: params.size ?? "auto",
    quality: params.quality ?? "auto",
    output_format: outputFormat,
  };
  if (params.inputFidelity) tool.input_fidelity = params.inputFidelity;
  if (params.imageModel) tool.model = params.imageModel;
  return tool;
}

async function generateStandardOpenAIImage(
  ctx: ExtensionContext,
  params: ImageGenerateParams,
  apiKey: string,
  outputFormat: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<{ path: string; revisedPrompt?: string }> {
  const res = await fetch(`${getCurrentBaseUrl(ctx).replace(/\/+$/, "")}/responses`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: getCurrentModel(ctx),
      input: [{ role: "user", content: buildImageInputContent(params, ctx.cwd) }],
      tools: [buildImageGenerationTool(params, outputFormat)],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI Responses image ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  const imageBase64 = extractImageResult(data);
  if (!imageBase64) throw new Error("No image_generation_call result found in response");

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.from(imageBase64, "base64"));
  return { path: outputPath };
}

async function generateCodexImage(
  ctx: ExtensionContext,
  params: ImageGenerateParams,
  apiKey: string,
  outputFormat: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<{ path: string; revisedPrompt?: string }> {
  const accountId = extractCodexAccountId(apiKey);
  const res = await fetch(resolveCodexResponsesUrl(getCurrentBaseUrl(ctx)), {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "chatgpt-account-id": accountId,
      originator: "pi",
      "User-Agent": "pi",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: getCurrentModel(ctx),
      store: false,
      stream: true,
      instructions: "Generate the requested image.",
      input: [{ role: "user", content: buildImageInputContent(params, ctx.cwd) }],
      tools: [buildImageGenerationTool(params, outputFormat)],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI Codex image ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const imageBase64 = await extractCodexImageResult(res);
  if (!imageBase64) throw new Error("No image_generation_call result found in Codex response");

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.from(imageBase64, "base64"));
  return { path: outputPath };
}

async function generateImage(
  ctx: ExtensionContext,
  params: ImageGenerateParams,
  signal?: AbortSignal,
): Promise<{ path: string; revisedPrompt?: string }> {
  const provider = getCurrentProvider(ctx) ?? "";
  if (!isOpenAIResponsesCompatible(ctx, provider)) {
    throw new Error(`Provider ${provider || "?"} is not OpenAI Responses-compatible`);
  }
  const apiKey = await getResolvedApiKey(ctx, provider);
  if (!apiKey) throw new Error(`No API key configured for provider ${provider}`);

  const outputFormat = params.outputFormat ?? "png";
  const outputPath = params.outputPath
    ? isAbsolute(params.outputPath)
      ? params.outputPath
      : resolve(ctx.cwd, params.outputPath)
    : defaultImageOutputPath(ctx.cwd, outputFormat);

  return isOpenAICodexCompatible(ctx, provider)
    ? generateCodexImage(ctx, params, apiKey, outputFormat, outputPath, signal)
    : generateStandardOpenAIImage(ctx, params, apiKey, outputFormat, outputPath, signal);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentProvider(ctx: ExtensionContext) {
  return ctx.model?.provider;
}
function getCurrentModel(ctx: ExtensionContext) {
  return ctx.model?.id ?? "";
}
function getCurrentBaseUrl(ctx: ExtensionContext) {
  return ctx.model?.baseUrl ?? "";
}
function isSearchAvailable(ctx: ExtensionContext, config: SearchConfig) {
  if (!config.enabled || !config.searchEnabled) return false;
  const p = getCurrentProvider(ctx);
  return p ? config.providerOverrides[p]?.searchEnabled !== false : false;
}
function isFetchAvailable(ctx: ExtensionContext, config: SearchConfig) {
  if (!config.enabled || !config.fetchEnabled) return false;
  const p = getCurrentProvider(ctx);
  return p ? config.providerOverrides[p]?.fetchEnabled !== false : false;
}
function isImageAvailable(ctx: ExtensionContext, config: SearchConfig) {
  if (!config.enabled || !config.imageEnabled) return false;
  const p = getCurrentProvider(ctx);
  return p ? isOpenAIResponsesCompatible(ctx, p) : false;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function searchExtension(pi: ExtensionAPI) {
  let config = loadConfig();

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web. Uses native provider search (ZAI MCP, Anthropic, Google, OpenAI, xAI) or DuckDuckGo fallback.",
    parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!isSearchAvailable(ctx, config))
        return {
          content: [
            {
              type: "text" as const,
              text: "Web search disabled. Use /search to enable.",
            },
          ],
          details: { error: "disabled" },
        };
      const provider = getCurrentProvider(ctx) ?? "";
      const model = getCurrentModel(ctx);
      const baseUrl = getCurrentBaseUrl(ctx);
      const cap = PROVIDERS[provider];
      const hasNative =
        (!!cap?.nativeSearch || isOpenAIResponsesCompatible(ctx, provider) || isAnthropicCompatible(ctx, provider)) &&
        (!!(await getResolvedApiKey(ctx, provider)) || provider === "claude-bridge");
      onUpdate?.({
        content: [
          {
            type: "text" as const,
            text: `Searching${hasNative ? ` (native: ${provider})` : " (DuckDuckGo)"}: "${params.query}"...`,
          },
        ],
      });
      try {
        const { text, nativeError } = await doSearch(
          ctx,
          params.query,
          provider,
          model,
          baseUrl,
          signal,
        );
        const out = nativeError
          ? `> Native failed (${nativeError.slice(0, 80)}), used DuckDuckGo.\n\n${text}`
          : text;
        return {
          content: [{ type: "text" as const, text: out }],
          details: {
            query: params.query,
            provider,
            method: hasNative && !nativeError ? "native" : "ddg",
          },
        };
      } catch (err: any) {
        if (signal?.aborted)
          return { content: [{ type: "text" as const, text: "Cancelled." }] };
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
    renderCall(a, t) {
      return new Text(
        t.fg("toolTitle", t.bold("web_search ")) + t.fg("muted", `"${a.query}"`),
        0,
        0,
      );
    },
    renderResult(r, { expanded, isPartial }, t) {
      if (isPartial) return new Text(t.fg("warning", "Searching..."), 0, 0);
      const text = r.content[0]?.text ?? "",
        lines = text.split("\n").length;
      return expanded
        ? new Text(text, 0, 0)
        : new Text(
            t.fg("success", "Found results") + t.fg("dim", ` (${lines} lines)`),
            0,
            0,
          );
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page's text content. Truncated to 50KB / 2000 lines.",
    parameters: Type.Object({ url: Type.String({ description: "URL" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!isFetchAvailable(ctx, config))
        return { content: [{ type: "text" as const, text: "Web fetch disabled." }] };
      const provider = getCurrentProvider(ctx) ?? "";
      const cap = PROVIDERS[provider];
      const useNative = !!cap?.nativeFetch && provider === "claude-bridge";
      onUpdate?.({
        content: [
          {
            type: "text" as const,
            text: `Fetching${useNative ? ` (native: ${provider})` : ""} ${params.url}...`,
          },
        ],
      });
      try {
        let text: string;
        let nativeError: string | undefined;
        if (useNative) {
          try {
            text = await claudeBridgeFetch(params.url, signal);
          } catch (err: any) {
            nativeError = err.message;
            text = await httpFetch(params.url, signal);
          }
        } else {
          text = await httpFetch(params.url, signal);
        }
        const out = nativeError
          ? `> Native failed (${nativeError.slice(0, 80)}), used local fetch.\n\n${text}`
          : text;
        return {
          content: [{ type: "text" as const, text: out }],
          details: {
            url: params.url,
            provider,
            method: useNative && !nativeError ? "native" : "local",
          },
        };
      } catch (err: any) {
        if (signal?.aborted)
          return { content: [{ type: "text" as const, text: "Cancelled." }] };
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
    renderCall(a, t) {
      return new Text(
        t.fg("toolTitle", t.bold("web_fetch ")) + t.fg("muted", a.url),
        0,
        0,
      );
    },
    renderResult(r, { expanded, isPartial }, t) {
      if (isPartial) return new Text(t.fg("warning", "Fetching..."), 0, 0);
      const text = r.content[0]?.text ?? "",
        lines = text.split("\n").length;
      return expanded
        ? new Text(text, 0, 0)
        : new Text(
            t.fg("success", "Fetched") + t.fg("dim", ` (${lines} lines)`),
            0,
            0,
          );
    },
  });

  pi.registerTool({
    name: "image_generate",
    label: "Image Generate",
    description:
      "Generate or edit an image using OpenAI Responses native image_generation. Supports local paths, data URLs, or HTTP URLs as referenceImages.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Image prompt or edit instruction" }),
      referenceImages: Type.Optional(
        Type.Array(Type.String({ description: "Local image path, image URL, or data URL" })),
      ),
      outputPath: Type.Optional(Type.String({ description: "Where to save the generated image" })),
      action: Type.Optional(Type.String({ description: "auto, generate, or edit" })),
      size: Type.Optional(Type.String({ description: "auto, 1024x1024, 1024x1536, or 1536x1024" })),
      quality: Type.Optional(Type.String({ description: "low, medium, high, or auto" })),
      outputFormat: Type.Optional(Type.String({ description: "png, webp, or jpeg" })),
      inputFidelity: Type.Optional(Type.String({ description: "low or high" })),
      imageModel: Type.Optional(Type.String({ description: "Optional image model override" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!isImageAvailable(ctx, config)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Image generation disabled or current provider is not OpenAI Responses-compatible.",
            },
          ],
          details: { error: "disabled" },
        };
      }
      onUpdate?.({
        content: [
          {
            type: "text" as const,
            text: `Generating image with ${getCurrentProvider(ctx)}/${getCurrentModel(ctx)}...`,
          },
        ],
      });
      try {
        const result = await generateImage(ctx, params as ImageGenerateParams, signal);
        return {
          content: [
            {
              type: "text" as const,
              text: `Generated image saved to ${result.path}`,
            },
          ],
          details: {
            path: result.path,
            provider: getCurrentProvider(ctx),
            model: getCurrentModel(ctx),
            references: (params.referenceImages ?? []).length,
          },
        };
      } catch (err: any) {
        if (signal?.aborted)
          return { content: [{ type: "text" as const, text: "Cancelled." }] };
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
    renderCall(a, t) {
      return new Text(
        t.fg("toolTitle", t.bold("image_generate ")) +
          t.fg("muted", `"${a.prompt}"`),
        0,
        0,
      );
    },
    renderResult(r, { isPartial }, t) {
      if (isPartial) return new Text(t.fg("warning", "Generating image..."), 0, 0);
      return new Text(r.isError ? t.fg("error", "Image generation failed") : t.fg("success", "Generated image"), 0, 0);
    },
  });

  // ─── Commands ───────────────────────────────────────────────────────────

  pi.registerCommand("search", {
    description: "Configure web search, fetch, and image tools",
    getArgumentCompletions(p) {
      return ["on", "off", "providers", "config"]
        .filter((c) => c.startsWith(p))
        .map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const sub = args?.trim().toLowerCase();
      if (sub === "providers") {
        await showProviders(ctx);
        return;
      }
      if (sub === "config") {
        showConfig(ctx);
        return;
      }
      if (sub === "on") {
        config.enabled = true;
        config.searchEnabled = true;
        config.fetchEnabled = true;
        config.imageEnabled = true;
        saveConfig(config);
        pi.setActiveTools([...pi.getActiveTools(), "web_search", "web_fetch", "image_generate"]);
        ctx.ui.notify("Search enabled", "info");
        return;
      }
      if (sub === "off") {
        config.enabled = false;
        saveConfig(config);
        pi.setActiveTools(
          pi.getActiveTools().filter((t) => t !== "web_search" && t !== "web_fetch" && t !== "image_generate"),
        );
        ctx.ui.notify("Search disabled", "info");
        return;
      }
      await showSearchSettings(ctx);
    },
  });

  // ─── Settings: only configured providers ────────────────────────────────

  async function showSearchSettings(ctx: ExtensionContext) {
    await ctx.ui.custom((tui, theme, _kb, done) => {
      const items: SettingItem[] = [
        {
          id: "enabled",
          label: "Search Extension",
          currentValue: config.enabled ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        },
        {
          id: "search",
          label: "Web Search",
          currentValue: config.searchEnabled ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        },
        {
          id: "fetch",
          label: "Web Fetch",
          currentValue: config.fetchEnabled ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        },
        {
          id: "image",
          label: "Image Generation",
          currentValue: config.imageEnabled ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        },
      ];

      const currentProvider = getCurrentProvider(ctx);
      for (const pid of Object.keys(PROVIDERS).sort()) {
        if (!hasCredentials(pid) && pid !== currentProvider) continue;
        const cap = PROVIDERS[pid]!;
        const override = config.providerOverrides[pid];
        const native = cap.nativeSearch ? " [native]" : "";
        const current = pid === currentProvider ? " ← current" : "";
        items.push({
          id: `provider:${pid}:search`,
          label: `${cap.name}${native}${current} - Search`,
          currentValue: override?.searchEnabled === false ? "disabled" : "enabled",
          values: ["enabled", "disabled"],
        });
      }

      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Search Settings"))));
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            "Showing configured providers only • /search providers for all",
          ),
        ),
      );
      container.addChild(new Text(""));

      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 20),
        getSettingsListTheme(),
        (id, val) => {
          if (id === "enabled") config.enabled = val === "enabled";
          else if (id === "search") config.searchEnabled = val === "enabled";
          else if (id === "fetch") config.fetchEnabled = val === "enabled";
          else if (id === "image") config.imageEnabled = val === "enabled";
          else if (id.startsWith("provider:")) {
            const pid = id.split(":")[1]!;
            if (!config.providerOverrides[pid]) config.providerOverrides[pid] = {};
            config.providerOverrides[pid]!.searchEnabled = val === "enabled";
          }
          saveConfig(config);
          applyToolsConfig(ctx);
        },
        () => done(undefined),
      );
      container.addChild(settingsList);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate • tab toggle • esc close")),
      );
      return {
        render(w: number) {
          return container.render(w);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(d: string) {
          settingsList.handleInput(d);
          tui.requestRender();
        },
      };
    });
  }

  // ─── All providers view ─────────────────────────────────────────────────

  async function showProviders(ctx: ExtensionContext) {
    const currentProvider = getCurrentProvider(ctx);
    const currentModel = getCurrentModel(ctx);
    const items: SelectItem[] = Object.entries(PROVIDERS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, cap]) => ({
        value: id,
        label: `${cap.name}${id === currentProvider ? " ← current" : ""}${hasCredentials(id) ? " ✓" : ""}`,
        description: `search: ${cap.nativeSearch ? `native (${id === "zai" ? "MCP" : id === "anthropic" ? "web_search server tool" : `model: ${id === currentProvider ? currentModel : "?"}`})` : "duckduckgo"} | key: ${hasCredentials(id) ? "yes" : "no"}`,
      }));

    await ctx.ui.custom((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("All Providers"))));
      container.addChild(new Text(theme.fg("dim", "✓ = has API key")));
      container.addChild(new Text(""));
      const sl = new SelectList(items, Math.min(items.length, 15), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      sl.onSelect = () => {};
      sl.onCancel = () => done(undefined);
      container.addChild(sl);
      container.addChild(new Text(theme.fg("dim", "esc close")));
      return {
        render(w: number) {
          return container.render(w);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(d: string) {
          sl.handleInput(d);
          tui.requestRender();
        },
      };
    });
  }

  function showConfig(ctx: ExtensionContext) {
    const provider = getCurrentProvider(ctx);
    const model = getCurrentModel(ctx);
    const baseUrl = getCurrentBaseUrl(ctx);
    const cap = provider ? PROVIDERS[provider] : undefined;
    ctx.ui.notify(
      [
        `Extension: ${config.enabled ? "enabled" : "disabled"}`,
        `Search: ${config.searchEnabled ? "enabled" : "disabled"} | Fetch: ${config.fetchEnabled ? "enabled" : "disabled"} | Image: ${config.imageEnabled ? "enabled" : "disabled"}`,
        ``,
        `Provider: ${cap?.name ?? (provider && isOpenAIResponsesCompatible(ctx, provider) ? "OpenAI Responses-compatible" : provider) ?? "?"} ${hasCredentials(provider ?? "") ? "✓" : "✗"}`,
        `Model: ${model || "?"}`,
        `Base URL: ${baseUrl || "?"}`,
        `Native: ${cap?.nativeSearch || (provider ? isOpenAIResponsesCompatible(ctx, provider) : false) ? `yes` : "no"} | Fallback: DuckDuckGo`,
      ].join("\n"),
      "info",
    );
  }

  // ─── Apply ──────────────────────────────────────────────────────────────

  function applyToolsConfig(ctx: ExtensionContext) {
    const a = pi
      .getActiveTools()
      .filter((t) => t !== "web_search" && t !== "web_fetch" && t !== "image_generate");
    if (config.enabled && isSearchAvailable(ctx, config)) a.push("web_search");
    if (config.enabled && isFetchAvailable(ctx, config)) a.push("web_fetch");
    if (config.enabled && isImageAvailable(ctx, config)) a.push("image_generate");
    pi.setActiveTools(a);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!config.enabled) {
      ctx.ui.setStatus("search", undefined);
      return;
    }
    const p = getCurrentProvider(ctx);
    const model = getCurrentModel(ctx);
    const cap = p ? PROVIDERS[p] : undefined;
    const m =
      p && (cap?.nativeSearch || isOpenAIResponsesCompatible(ctx, p) || isAnthropicCompatible(ctx, p))
        ? `native:${p === "zai" ? "mcp" : p === "claude-bridge" ? "cc-sdk" : model || p}`
        : "ddg";
    const fetchBackend =
      cap?.nativeFetch && hasCredentials(p ?? "") && p === "claude-bridge"
        ? "fetch:cc-sdk"
        : "fetch";
    const parts: string[] = [];
    if (config.searchEnabled) parts.push(`search:${m}`);
    if (config.fetchEnabled) parts.push(fetchBackend);
    if (config.imageEnabled && p && isOpenAIResponsesCompatible(ctx, p)) parts.push("image:native");
    ctx.ui.setStatus(
      "search",
      parts.length
        ? ctx.ui.theme.fg("accent", `search[${parts.join(",")}]`)
        : undefined,
    );
  }

  pi.on("session_start", async (_, ctx) => {
    config = loadConfig();
    applyToolsConfig(ctx);
    updateStatus(ctx);
  });
  pi.on("model_select", async (_, ctx) => {
    config = loadConfig();
    applyToolsConfig(ctx);
    updateStatus(ctx);
  });
  pi.on("session_tree", async (_, ctx) => {
    config = loadConfig();
    applyToolsConfig(ctx);
    updateStatus(ctx);
  });
}
