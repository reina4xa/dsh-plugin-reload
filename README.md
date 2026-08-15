# dsh-plugin-reload

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a **`reload_plugin` tool**: restart exactly one Cordis Loader entry — matched by entry id, module name, or MCP `serverName`. Every other entry keeps running.

Two reload strategies are chosen per entry kind:

- **`mcp-client` entries** respawn the MCP server child process on restart (picking up new server code on disk) and re-register its tools; sibling MCP connections are not affected.
- **in-process plugin entries** get a **hard reload**: the Node ESM/CJS module caches for the entry and its local source files are busted, the entry is re-imported from disk, and its fibers are swapped onto the fresh module — the same technique `cordis-plugin-hmr`'s partial reload uses. Plugin code changes take effect **without restarting the host**, and a failed re-import or re-apply rolls back to the previous code.

> Built on the "everything is a plugin" architecture of DeepSeek Harness. The official repository does not accept external pull requests at the moment — per [CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/CONTRIBUTING.md), community plugins are published independently and shared under the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic.

## Install (auto-mount)

Since **v0.1.2** the package declares a `dsh.bundle`, so a single command installs the plugin **and** automatically mounts it:

```sh
dsh plugin --profile web add dsh-plugin-reload
```

What happens under the hood:

1. `dsh plugin` runs `pnpm add` inside the profile directory (`~/.dsh/profiles/<name>/`).
2. On success it reconciles the profile manifest: because `dsh-plugin-reload` declares `dsh.bundle` in its `package.json`, it is appended to the profile's `dsh.profile.bundles` layer list.
3. On the next harness start the bundle layer is composed, and the plugin's own `cordis.patch.yml` inserts the `plugin-reload` entry — the tool appears in the model's tool list with **no manual patch editing**.

To pick up a later version:

```sh
dsh plugin --profile web update dsh-plugin-reload
```

> Freshly published versions may be held back briefly by pnpm's `minimumReleaseAge` supply-chain policy; an explicit version (`dsh plugin --profile web add dsh-plugin-reload@0.1.x`) bypasses it.

## Manual mount (alternative)

If you install the package with plain `npm` (not via `dsh plugin`), or prefer an explicit patch row, add it to your profile patch (`~/.dsh/profiles/<name>/cordis.patch.yml`, or a `--patch` overlay):

```yaml
- insert:
    - id: plugin-reload
      name: 'dsh-plugin-reload'
```

Restart the harness (or let profile-patch HMR pick it up). Keep either the bundle mount or the manual row — not both (a duplicate tool registration fails at load).

## Usage

`reload_plugin` accepts:

| Argument | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Entry id (preferred), module name, or MCP `config.serverName` of the entry to reload |
| `mode` | no | `auto` (default) — hard reload for in-process plugins, fiber restart for mcp-client; `soft` — dispose and re-apply only (never picks up in-process code changes); `hard` — bust ESM/CJS caches and re-import the entry code from disk |
| `dry_run` | no | `true` reports the single matched entry and the strategy that would run, without restarting it |

Matching walks the Loader's non-group entries once: exact entry id first, then module name, then mcp-client `serverName`. Zero matches fail with a bounded list of available entries; multiple matches fail listing the candidate entry ids and change nothing. Group entries never match — restarting a subtree requires one call per leaf entry.

A successful reload returns the entry id, module, optional `serverName`, previous and current fiber phases, the strategy used, and a semantics note. A hard reload writes nothing back to the loader config: the entry's options stay untouched, only its fiber is swapped onto the re-imported module.

## Requirements

- A DeepSeek Harness profile with the web (or headless) bundle, i.e. the standard `dsh` runtime with `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis-plugin-loader` available.

## Known limitations

- **Brief tool outage during reload** — the reloaded entry's contributions (e.g. MCP tools) are unregistered between disposal and re-application; in-flight calls to those tools fail.
- **No group reload** — restarting a whole plugin subtree must be requested per leaf entry.
- **Hard reload covers the plugin's own code only** — dependencies in `node_modules` (e.g. `@deepseek-ai/*`, `ws`) are intentionally not re-imported; changing those still requires a host restart. Module-level state of the reloaded plugin is re-evaluated (a fresh `import`), so plugins must not rely on top-level persistent state surviving a reload.
- **Agent-facing only** — no browser/UI surface; the Settings plugin-inventory tab stays read-only.

## Development

```sh
npm install        # dev deps (types + typescript) from npm
npm run build      # tsc → lib/
npm test           # vitest
npm pack           # inspect the tarball before publishing
```

## License

MIT
