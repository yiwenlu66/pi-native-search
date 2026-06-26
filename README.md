# pi-native-search

[![npm version](https://img.shields.io/npm/v/pi-native-search)](https://www.npmjs.com/package/pi-native-search)
[![license](https://img.shields.io/npm/l/pi-native-search)](LICENSE)

A [pi](https://github.com/badlogic/pi-mono) extension that adds `web_search`, `web_fetch`, and `image_generate` tools. Search routes each call through the **active provider's own native search backend** when available, and falls back to DuckDuckGo HTML scraping otherwise. Image generation uses OpenAI Responses-compatible providers, including the ChatGPT Codex OAuth backend for `openai-codex`.

The headline feature: when you're using your **Claude Code subscription via [pi-claude-bridge](https://www.npmjs.com/package/pi-claude-bridge)**, search and fetch are delegated to Claude Code's actual `WebSearch` and `WebFetch` tools — the same ones you get in Zed, Claude Desktop, or the Claude Code CLI. No separate API key required.

## Why

Pi ships with provider plumbing but no built-in search. Most extensions either (a) hard-code DuckDuckGo, or (b) require you to wire up your own paid search API. This extension uses what each provider already gives you for free.

| Provider | Native backend | Auth source |
|---|---|---|
| **claude-bridge** (Claude Code subscription) | Claude Code's `WebSearch` / `WebFetch` (via `@anthropic-ai/claude-agent-sdk`) | Your `claude` CLI login |
| **zai** (GLM) | ZAI MCP `web_search_prime` (included in Coding Plans, *not* the separate paid Web Search API) | `ZAI_API_KEY` |
| **anthropic** | `web_search_20250305` server tool | `ANTHROPIC_API_KEY` |
| **google** (Gemini) | `google_search` grounding tool | `GEMINI_API_KEY` |
| **openai** | Responses API `web_search` tool | `OPENAI_API_KEY` |
| **xai** (Grok) | Responses API `web_search` tool | `XAI_API_KEY` |
| All other providers | DuckDuckGo HTML fallback | none |

`web_fetch` uses the same routing — currently only `claude-bridge` has a native backend; everything else uses a built-in HTTP fetcher.

## Install

```bash
pi install npm:pi-native-search
```

The extension auto-detects your active provider via pi's `ctx.model.provider` and picks the right backend on every call.

## Usage

Once installed, three tools become available to the model:

- `web_search { query }` — searches the web and returns ranked results.
- `web_fetch { url }` — fetches and returns a page's text content (truncated to 50 KB / 2000 lines).
- `image_generate { prompt, ... }` — generates or edits images through OpenAI Responses image generation. With `openai-codex`, the extension uses the Codex OAuth endpoint (`/backend-api/codex/responses`) and required Codex headers instead of the standard `/v1/responses` API-key path.

The model decides when to use them; you don't need to do anything else. To configure or inspect the extension, use the `/search` slash command:

```
/search           # open the settings panel (configured providers only)
/search providers # show ALL providers and their capabilities
/search config    # print current config (active provider, native vs. ddg, etc.)
/search on        # enable both tools
/search off       # disable the extension entirely
```

The bottom status bar shows the active backend per call, e.g.:

```
search[search:native:cc-sdk,fetch:cc-sdk]    # claude-bridge route
search[search:native:mcp,fetch]               # ZAI route
search[search:ddg,fetch]                      # DDG fallback
```

Configuration persists in `~/.pi/agent/search-config.json`.

## How it works

The dispatcher in `doSearch` (and the `web_fetch` handler) reads the active provider from the extension context and selects a backend:

```ts
async function doSearch(query, provider, model, baseUrl, signal) {
  const cap = PROVIDERS[provider];
  if (cap?.nativeSearch && hasAuth) {
    switch (provider) {
      case "zai":           return zaiSearch(query, apiKey, signal);
      case "google":        return googleSearch(query, model, apiKey, signal);
      case "openai":        return openaiSearch(query, model, apiKey, signal);
      case "xai":           return xaiSearch(query, model, apiKey, signal);
      case "anthropic":     return anthropicSearch(query, model, apiKey, baseUrl, signal);
      case "claude-bridge": return claudeBridgeSearch(query, signal);
    }
  }
  return ddgSearch(query, signal); // fallback
}
```

If the native call throws, the result is silently swapped for the DDG fallback with a `> Native failed (...)` prefix so you can see what went wrong without losing the search result.

### claude-bridge specifics

When the active provider is `claude-bridge`, the extension dynamically locates `@anthropic-ai/claude-agent-sdk` (shipped inside `pi-claude-bridge`'s own `node_modules`) and spawns a one-shot `query()` with `allowedTools: ["WebSearch"]` (or `["WebFetch"]`). The result text is captured and returned as the tool output. This means:

- No extra dependency to install — reuses what `pi-claude-bridge` already brought in.
- Auth comes from your `claude` CLI login, not an API key.
- It uses your subscription, not API credits.

## Adding a new provider

The extension is structured so that adding a backend is a self-contained change. To add provider `foo`:

**1. Add an entry to the `PROVIDERS` map** at the top of `extensions/index.ts`:

```ts
foo: {
  name: "Foo Provider",
  nativeSearch: true,
  nativeFetch: false,
  envKey: "FOO_API_KEY",
},
```

**2. Implement the search function**:

```ts
async function fooSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch("https://api.foo.com/search", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, model }),
  });
  if (!res.ok)
    throw new Error(`Foo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  // Format as numbered list with title, url, snippet
  return data.results
    .map(
      (r: any, i: number) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
    )
    .join("\n\n");
}
```

**3. Add a case to `doSearch`**:

```ts
case "foo":
  return { text: await fooSearch(query, model, apiKey, signal) };
```

That's it. The settings UI, status line, and fallback handling all pick it up automatically from the `PROVIDERS` map.

If the provider doesn't use a standard `Bearer` API key (e.g. OAuth, MCP session, or an SDK that handles auth itself like `claude-bridge`), see `claudeBridgeSearch` for how to special-case the auth check in `hasCredentials` and the `hasAuth` gate in `doSearch`.

## Development

```bash
git clone https://github.com/smalibary/pi-native-search.git
cd pi-native-search
# Edit extensions/index.ts, then test by symlinking into pi:
cp extensions/index.ts ~/.pi/agent/extensions/pi-native-search/index.ts
# In pi: /reload
```

The extension is a single TypeScript file (`extensions/index.ts`) that pi loads via `tsx` at runtime — no build step required.

## License

MIT — see [LICENSE](LICENSE). PRs welcome, especially for new provider backends.

## Acknowledgements

- [pi](https://github.com/badlogic/pi-mono) by Mario Zechner — the host TUI agent
- [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson — provides the Claude Agent SDK that `claude-bridge` mode reuses
