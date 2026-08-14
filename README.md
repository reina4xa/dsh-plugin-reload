# dsh-plugin-reload

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a **`reload_plugin` tool**: restart exactly one Cordis Loader entry — matched by entry id, module name, or MCP `serverName` — by disposing its fiber and re-applying the plugin with unchanged config. Every other entry keeps running.

Reloading an `mcp-client` entry respawns that MCP server child process (picking up new server code on disk) and re-registers its tools; sibling MCP connections are not affected.

> Built on the "everything is a plugin" architecture of DeepSeek Harness. The official repository does not accept external pull requests at the moment — per [CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/CONTRIBUTING.md), community plugins are published independently and shared under the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic.

## Install

```sh
# install the plugin into your web profile (pnpm manages the profile)
dsh plugin --profile web add dsh-plugin-reload

# or install it wherever you keep dsh profile dependencies
npm install dsh-plugin-reload
```

## Mount

Add an insert row to your profile patch (`~/.dsh/profiles/<name>/cordis.patch.yml`, or a `--patch` overlay):

```yaml
- insert:
    - id: plugin-reload
      name: 'dsh-plugin-reload'
```

Restart the harness (or let profile-patch HMR pick it up). The `reload_plugin` tool then appears in the model's tool list.

## Usage

`reload_plugin` accepts:

| Argument | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Entry id (preferred), module name, or MCP `config.serverName` of the entry to reload |
| `dry_run` | no | `true` reports the single matched entry without restarting it |

Matching walks the Loader's non-group entries once: exact entry id first, then module name, then mcp-client `serverName`. Zero matches fail with a bounded list of available entries; multiple matches fail listing the candidate entry ids and change nothing. Group entries never match — restarting a subtree requires one call per leaf entry.

A successful reload returns the entry id, module, optional `serverName`, previous and current fiber phases, and a fixed semantics note. The reload runs through the fiber's public `restart()` — dispose and immediately reload with the current config — so nothing is written back to the loader config.

## Requirements

- A DeepSeek Harness profile with the web (or headless) bundle, i.e. the standard `dsh` runtime with `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis-plugin-loader` available.

## Known limitations

- **Brief tool outage during reload** — the reloaded entry's contributions (e.g. MCP tools) are unregistered between disposal and re-application; in-flight calls to those tools fail.
- **No group reload** — restarting a whole plugin subtree must be requested per leaf entry.
- **Agent-facing only** — no browser/UI surface; the Settings plugin-inventory tab stays read-only.

## Development

```sh
npm install        # dev deps (types + typescript) from npm
npm run build      # tsc → lib/
npm pack           # inspect the tarball before publishing
```

## License

MIT
