# dsh-vcpkg

vcpkg tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The plugin gives the agent six tools for working with a vcpkg-managed C++ project: which tree is in use,
what the manifest declares against what is actually installed, which ports exist in the registry, and how
to install them.

It also handles the proxy problem. vcpkg downloads ports through libcurl and clones its registry through
git, and on many corporate and Chinese networks GitHub is reachable only through a local proxy client. When
that proxy is not in the environment, the failure appears thousands of lines into a build log as
`curl: (7) Failed to connect to github.com port 443`. Every vcpkg process these tools start is given a
resolved proxy first, so that failure does not happen.

## Tools

| Tool | Purpose |
| --- | --- |
| `vcpkg_info` | The vcpkg tree in use, its version, the triplet, the manifest that was found, and the proxy in effect. |
| `vcpkg_manifest` | Diffs `vcpkg.json` against the installed package database. |
| `vcpkg_list` | The installed packages, with versions and enabled features. |
| `vcpkg_search` | Looks up port and feature names in the registry. |
| `vcpkg_proxy` | Reports, tests, and pins the proxy that vcpkg network access goes through. |
| `vcpkg_install` | Runs `vcpkg install`, in the foreground or as a background job. |

## Install

The plugin is a standard DSH bundle. Install it from the Harness GUI, through the `plugin_manager` tool, or
from a shell:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-vcpkg
```

DSH records the dependency in the profile's `package.json` and appends `dsh-vcpkg` to
`dsh.profile.bundles`, which mounts `cordis.patch.yml` as an additional layer.

The plugin declares `@deepseek-ai/dsh-tools` as a peer dependency in the range `>=0.2.0-rc.2 <1.0.0`. A DSH
build outside that range silently skips the whole bundle, so widen the range deliberately.

## Proxy handling

The network is resolved before vcpkg starts, not after it fails. `prepareInvocation` is the first statement
of every tool body, and the result is injected into the environment of the child process it spawns. The
Harness process environment is never modified, so a wrong guess costs one tool call rather than the rest of
the session.

Sources are tried in this order:

1. `proxy` in the settings file, pinned with `vcpkg_proxy action "set"`.
2. The plugin's `proxy` config, pinned from a profile's `cordis.patch.yml`.
3. `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY`, or `all_proxy`.
4. `git config --global http.proxy`.
5. A TCP probe of the ports that shipping proxy clients listen on.

Step 5 covers Clash, Clash Verge and Mihomo (7890, 7897, 7891), v2rayN (10809), V2Ray (1080), Surge (6152),
Charles and Fiddler (8888), and the generic proxies on 8080, 3128 and 8118.

### Using vcpkg_proxy

It runs on its own before every other tool. Call it directly when a download has already failed:

```
vcpkg_proxy action "status"     # what is in effect, and which local ports are open
vcpkg_proxy action "probe"      # real HTTPS requests to the registry, direct and through the proxy
vcpkg_proxy action "set" proxy "http://127.0.0.1:7897"
vcpkg_proxy action "clear"
```

`probe` is the one that gives a definite answer. An open TCP port only proves that something is listening
on it, so `probe` issues an actual request to `https://github.com/microsoft/vcpkg` both directly and through
the proxy, and reports the HTTP status of each attempt.

Automatic detection adopts the first reachable local proxy without asking. That is the case the plugin
exists for, and the choice is reported in every tool result. Set `autoDetectProxy: false` to disable it, or
run `vcpkg_proxy action "clear"` and stop the proxy client to force direct access.

## What the output looks like

`vcpkg_info` on a repository whose manifest lives below the workspace root:

```
vcpkg root: /Users/you/Developer/Cpp/vcpkg
  found via: the VCPKG_ROOT environment variable
  binary: /Users/you/Developer/Cpp/vcpkg/vcpkg
  version: 2026-07-27-98d7cb0cf1f4686a3e43aa5672b6230c1d56bce8
  checkout HEAD: 9f8f0c7bfa1a8f393cd4da3f49c1163d7daa774f
  toolchain file: /Users/you/Developer/Cpp/vcpkg/scripts/buildsystems/vcpkg.cmake
  VCPKG_ROOT env: /Users/you/Developer/Cpp/vcpkg
triplet: arm64-osx (from the host platform default)
network: http://127.0.0.1:7897 (auto-detect)
manifest: /repo/crates/native/vcpkg.json (a bounded search below the working directory)
  name: 3dtiles
  declared dependencies: 20
  builtin-baseline: 9f8f0c7bfa1a8f393cd4da3f49c1163d7daa774f
```

`vcpkg_manifest` against the same project:

```
manifest: /repo/crates/native/vcpkg.json
  name: 3dtiles
  version: 1.0.0 (version-string)
  builtin-baseline: 9f8f0c7bfa1a8f393cd4da3f49c1163d7daa774f
  declared dependencies: 20
installed (/repo/build/cmake_build/vcpkg_installed, triplet arm64-osx): 175 packages
  satisfied: 20/20
  every declared dependency and feature is installed
```

## Configuration

Every field has a working default, so the inserted row carries no `config`. To override it, add a targeted
row in the profile's own `cordis.patch.yml`. A targeted row replaces the config wholesale rather than
merging into it:

```yaml
- id: dsh-vcpkg
  config:
    vcpkgRoot: /Users/you/Developer/Cpp/vcpkg
    proxy: http://127.0.0.1:7897
    autoDetectProxy: true
    enableBackgroundInstall: true
```

| Field | Meaning |
| --- | --- |
| `vcpkgRoot` | Pins the vcpkg tree, ahead of `VCPKG_ROOT`. |
| `triplet` | Pins the triplet, behind `VCPKG_DEFAULT_TRIPLET` and an explicit argument. |
| `proxy`, `noProxy` | Pins a proxy and extra bypass hosts. |
| `proxyCandidates` | Extra proxy URLs to probe before the built-in list. |
| `autoDetectProxy` | Probes well-known local proxy ports. Defaults to `true`. |
| `enableBackgroundInstall` | Exposes `runInBackground` on `vcpkg_install`. Defaults to `true`. |

A pin written by `vcpkg_proxy action "set"` goes to `<dshHome>/vcpkg.json` instead, because a proxy and a
vcpkg location describe one machine rather than one deployment.

## Requirements

- Node 20 or newer. The plugin ships plain ESM and has no build step.
- A bootstrapped vcpkg tree for anything that runs vcpkg. The read-only tools work without one.
- `git`, for the `git config http.proxy` source. If it is missing, that source is skipped and reported.
- `curl`, for the end-to-end checks in `vcpkg_proxy action "probe"`. Without it, that action falls back to
  TCP probes.

## Security notes

`vcpkg_install` runs a real build, and a build executes the build scripts shipped with each port. Treat it
like any other build command when composing tool policy. A deployment that wants approval gates can
intercept `tools/pre-execute`.

Every vcpkg process is spawned without a shell, using an argument vector the plugin constructs, so no model
input reaches a command line as text. The `manifestRoot` argument selects a directory and is never
interpreted as a command.

Process spawning here is not confined by the `@deepseek-ai/dsh-bash-sandbox` policy, which governs
`ctx.shell`; these tools call `node:child_process` directly, as the LSP and subprocess tools do. That is
also why they work in a workspace-write session. vcpkg takes an exclusive lock at
`<vcpkgRoot>/buildtrees/vcpkg-running.lock` and writes its installed tree outside the workspace, so the same
`vcpkg install` run through a sandboxed shell can fail with
`try_take_exclusive_file_lock(...): Operation not permitted`. When a sandboxed shell reports that error, the
cause is the sandbox and not a concurrent vcpkg.

The only files the plugin writes are its own settings file and whatever vcpkg writes.

## Development

```bash
node --test tests/smoke.mjs
```

The suite is self-contained. Tests that need a real vcpkg binary skip themselves with a printed reason when
none is installed. Everything else runs against `tests/fixtures/workspace/`, a synthetic project with a
nested manifest and a populated installed-package database, so the assertions do not depend on the machine
they run on.

Tests that need `@deepseek-ai/dsh-tools` resolvable from the plugin directory skip in the same way, which is
what happens when the plugin is not installed into a profile.

### Live reloading

DSH's HMR watcher starts with an empty root list, so edits to the plugin source do not reach a running
Harness by default. To make them apply without a restart, point the watcher at the plugin directory in the
profile's `cordis.patch.yml`:

```yaml
- id: hmr
  config:
    base: /absolute/path/to/dsh-vcpkg
    root: ["."]
    ignored: ["**/node_modules", "**/.*", "**/*.md", "cache", "data"]
```

`base` is resolved against the profile directory, so an absolute path is required. The `ignored` list
replaces the default, which is why the two default patterns are repeated here; `**/*.md` is added so that
documentation edits do not trigger a reload.

## Known limitations

- **The background job path targets the 0.2.0 job API.** Output is pushed through the job handle's `append`,
  which leaves the job's output ring as the only carrier. A producer that also fills the outcome's `result`
  with the same bytes makes `job_output` render the whole build log twice. The 0.1.x shape, with an `Agent`
  as `owner`, a `readOutput` consumer cursor and `JobOutcome.output`, is not supported: on such a runtime the
  job registers, reports a successful exit code, and leaves the log unreadable.
- **Automatic detection cannot tell a working proxy from a merely listening one.** It adopts the first open
  local port, so a proxy client that is running but cannot reach GitHub wins over a direct route that would
  have worked. `vcpkg_proxy action "probe"` distinguishes the two on demand. Resolution does not pay for a
  TLS request on every call.
- **Only HTTP and SOCKS proxy URLs are understood.** PAC files and system proxy settings are not read,
  because neither curl nor git honours them.
- **`vcpkg_install` has no deadline.** A pathologically slow port build can hold a foreground call open
  indefinitely. Background mode exists for that reason, and the tool-call timeout policy can still impose
  its own bound.
- **Port metadata is limited to what `vcpkg search` prints.** There is no `vcpkg_port_info`, and the
  dependency tree of a single port is not exposed.
- **`vcpkg_install` passes no registry or asset-source flags.** A deployment that redirects
  `X_VCPKG_ASSET_SOURCES` has to set it in the environment the Harness itself runs in.

## License

MIT. See [LICENSE](LICENSE).
