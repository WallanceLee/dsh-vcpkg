# dsh-vcpkg

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 vcpkg 工具集。

插件提供六个工具，让 agent 能操作一个由 vcpkg 管理依赖的 C++ 工程：当前用的是哪一棵 vcpkg、清单声明的
依赖和实际装上的差在哪、registry 里有哪些端口，以及怎么把它们装上。

它同时处理代理问题。vcpkg 用 libcurl 下载端口、用 git 克隆 registry，而在很多公司内网和国内网络环境下，
GitHub 只能通过本地代理客户端访问。代理没进环境变量时，失败会在构建日志几千行之后才表现为一句
`curl: (7) Failed to connect to github.com port 443`。这些工具启动的每个 vcpkg 进程都会先拿到解析好的
代理，所以这种失败不会发生。

## 工具

| 工具 | 用途 |
| --- | --- |
| `vcpkg_info` | 当前用的 vcpkg 树、版本、三元组、找到的清单，以及生效的代理。 |
| `vcpkg_manifest` | 把 `vcpkg.json` 和已安装包数据库做 diff。 |
| `vcpkg_list` | 已安装的包，带版本和已启用的特性。 |
| `vcpkg_search` | 在 registry 里查端口名和特性名。 |
| `vcpkg_proxy` | 查看、测试、钉住 vcpkg 网络访问走的代理。 |
| `vcpkg_install` | 执行 `vcpkg install`，前台跑或作为后台 job 跑。 |

## 安装

在 DeepSeek Harness 应用里打开 **Plugins**，选 **Add plugin**，填入本目录的绝对路径。用
`plugin_manager` 工具做同一件事：

```
plugin_manager   action "install_bundle"   target "/absolute/path/to/dsh-vcpkg"
```

两种方式都会把依赖写进当前活动 profile 的 `package.json`，并把 `dsh-vcpkg` 追加到 `dsh.profile.bundles`，
从而把 `cordis.patch.yml` 挂成新的一层。

### 关于 profile

桌面应用只拥有一个 profile，并且不把它暴露给命令行：

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

所以进入那个 profile 的方式是应用自己的界面，或者 `plugin_manager` 工具。命令行管的是那批由出厂模板
初始化的 profile，headless 与自动化运行用的就是它们：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-vcpkg
```

出厂模板有五个：`web`、`headless`、`sdk`、`sdk-minimal`、`acp`。其它名字会用 `@deepseek-ai/dsh-base`
单独初始化。

插件把 `@deepseek-ai/dsh-tools` 声明为范围 `>=0.2.0-rc.2 <1.0.0` 的 peer 依赖。超出该范围的 DSH 构建会
静默跳过整个 bundle，所以要放宽范围请有意为之。

## 代理处理

网络在 vcpkg 启动之前解析，而不是等它失败之后。`prepareInvocation` 是每个工具函数体的第一条语句，解析结果
注入它派生的子进程环境。Harness 自身的进程环境从不被修改，所以猜错只花掉一次工具调用。

来源按以下顺序尝试：

1. 设置文件里的 `proxy`，由 `vcpkg_proxy action "set"` 钉住。
2. 插件的 `proxy` 配置，由 profile 的 `cordis.patch.yml` 钉住。
3. `HTTPS_PROXY`、`https_proxy`、`ALL_PROXY` 或 `all_proxy`。
4. `git config --global http.proxy`。
5. 对常见代理客户端监听端口做 TCP 探测。

第 5 步覆盖 Clash、Clash Verge、Mihomo（7890、7897、7891）、v2rayN（10809）、V2Ray（1080）、
Surge（6152）、Charles 与 Fiddler（8888），以及 8080、3128、8118 上的通用代理。

### 用 vcpkg_proxy

它会在其它工具运行之前自动跑，所以只在下载已经失败时才需要直接调用：

```
vcpkg_proxy action "status"     # 当前生效的是什么，本地哪些端口开着
vcpkg_proxy action "probe"      # 对 registry 发真实 HTTPS 请求，直连与走代理各一次
vcpkg_proxy action "set" proxy "http://127.0.0.1:7897"
vcpkg_proxy action "clear"
```

能给准话的是 `probe`。端口开着只说明有东西在监听，所以它会真的对
`https://github.com/microsoft/vcpkg` 各发一次请求（直连和走代理），并分别报出 HTTP 状态码。

自动探测会直接采用第一个可达的本地代理，不询问。这正是插件存在的场景，而且这个选择会出现在每一份工具结果里。
设 `autoDetectProxy: false` 可以关掉；要强制直连，跑 `vcpkg_proxy action "clear"` 并停掉代理客户端。

## 输出长什么样

在清单位于工作区子目录的工程上跑 `vcpkg_info`：

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

同一个工程上的 `vcpkg_manifest`：

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

## 配置

每个字段都有可用默认值，所以插入的那一行不带 `config`。要覆盖就在 profile 自己的 `cordis.patch.yml` 里加一条
定向行。定向行是整体替换 config，不会往里合并：

```yaml
- id: dsh-vcpkg
  config:
    vcpkgRoot: /Users/you/Developer/Cpp/vcpkg
    proxy: http://127.0.0.1:7897
    autoDetectProxy: true
    enableBackgroundInstall: true
```

| 字段 | 含义 |
| --- | --- |
| `vcpkgRoot` | 钉住 vcpkg 树，优先于 `VCPKG_ROOT`。 |
| `triplet` | 钉住三元组，位于 `VCPKG_DEFAULT_TRIPLET` 和显式参数之后。 |
| `proxy`、`noProxy` | 钉住代理和额外的绕过主机。 |
| `proxyCandidates` | 在内置列表之前先探测的额外代理 URL。 |
| `autoDetectProxy` | 是否探测常见本地代理端口。默认 `true`。 |
| `enableBackgroundInstall` | 是否在 `vcpkg_install` 上暴露 `runInBackground`。默认 `true`。 |

由 `vcpkg_proxy action "set"` 写入的 pin 落在 `<dshHome>/vcpkg.json`，因为代理和 vcpkg 位置描述的是一台机器，
不是一个部署。

## 依赖

- Node 20 以上。插件是纯 ESM，没有构建步骤。
- 任何实际跑 vcpkg 的操作都需要一棵已 bootstrap 的 vcpkg 树。只读工具不需要。
- `git`，用于 `git config http.proxy` 这一来源。缺失时会跳过该来源并报告。
- `curl`，用于 `vcpkg_proxy action "probe"` 的端到端检查。缺失时该动作降级为 TCP 探测。

## 安全说明

`vcpkg_install` 会启动真实构建，而构建会执行每个端口自带的构建脚本。编排工具策略时请把它当作普通构建命令对待。
需要审批闸的部署可以拦截 `tools/pre-execute`。

每个 vcpkg 进程都不经 shell 启动，参数向量由插件构造，因此没有任何模型输入以文本形式进入命令行。`manifestRoot`
参数选择的是目录，永远不会被当成命令解释。

这里的进程派生不受 `@deepseek-ai/dsh-bash-sandbox` 策略约束，那条策略管的是 `ctx.shell`；这些工具直接调
`node:child_process`，与 LSP、subprocess 类工具的做法一致。这也正是它们在 workspace-write 会话里能用的原因。
vcpkg 会在 `<vcpkgRoot>/buildtrees/vcpkg-running.lock` 取排他锁，并把 installed 树写在工作区之外，所以同一条
`vcpkg install` 走沙箱内的 shell 可能报 `try_take_exclusive_file_lock(...): Operation not permitted`。沙箱内的
shell 报这个错，原因是沙箱，不是有另一个 vcpkg 在跑。

插件写盘的对象只有它自己的设置文件，以及 vcpkg 自己写的东西。

## 开发

```bash
node --test tests/smoke.mjs
```

测试套件是自包含的。需要真实 vcpkg 二进制的测试在没有安装时自行跳过并打印原因。其余全部跑在
`tests/fixtures/workspace/` 上，那是一个合成的工程，带嵌套清单和已填充的已安装包数据库，因此断言不依赖运行它的
机器。

需要插件目录能解析到 `@deepseek-ai/dsh-tools` 的测试同样会跳过，插件没装进任何 profile 时就是这种情况。

### 热重载

DSH 的 HMR watcher 启动时监听根列表是空的，所以插件源码的改动默认到不了正在运行的 Harness。想免去每次重启，
在 profile 自己的 `cordis.patch.yml` 里把 watcher 指到插件目录，桌面应用对应的是
`$DSH_HOME/profiles/desktop/cordis.patch.yml`：

```yaml
- id: hmr
  config:
    base: /absolute/path/to/dsh-vcpkg
    root: ["."]
    ignored: ["**/node_modules", "**/.*", "**/*.md", "cache", "data"]
```

`base` 相对 profile 目录解析，所以必须写绝对路径。`ignored` 是整体替换默认值，因此这里重复了默认的两条模式；
额外加的 `**/*.md` 让改文档不触发重载。

## 已知限制

- **后台任务走的是 0.2.0 的 job API。** 输出通过 job handle 的 `append` 推入 job 自带的 output ring，ring 是
  输出的唯一载体。如果同时把同样的字节塞进 outcome 的 `result`，`job_output` 会把整份构建日志渲染两遍。
  0.1.x 那套形状（`owner` 传 `Agent` 对象、实现 `readOutput` 消费游标、输出读 `JobOutcome.output`）不受支持：
  在那样的运行时上，job 会注册成功、报一个成功的 exit code，而日志读不出来。
- **自动探测分不清「能用的代理」和「只是在监听的代理」。** 它采用第一个开着的本地端口，因此一个在运行但连不上
  GitHub 的代理客户端，会盖过一个本来可用的直连。`vcpkg_proxy action "probe"` 可按需区分两者；解析过程不会为
  每次调用付一次 TLS 请求的代价。
- **只理解 HTTP 与 SOCKS 代理 URL。** 不读 PAC 文件和系统代理设置，因为 curl 与 git 都不认它们。
- **`vcpkg_install` 没有截止时间。** 病态的慢速端口构建可以让前台调用无限期挂住。后台模式就是为此存在的，
  而工具调用超时策略仍可施加自己的上限。
- **端口元数据只限于 `vcpkg search` 打印的内容。** 没有 `vcpkg_port_info`，单个端口的依赖树不暴露。
- **`vcpkg_install` 不传任何 registry 或 asset-source 参数。** 重定向了 `X_VCPKG_ASSET_SOURCES` 的部署需要在
  Harness 自身运行的环境里设置它。

## 许可

MIT，见 [LICENSE](LICENSE)。
