# Pi Studio 扩展发行、安装与 Registry

本文描述 Pi Studio 扩展从开发、打包、发布、发现、安装、升级、回滚到卸载的完整链路。运行时清单、权限与 UI 数据契约见 [extensions.md](./extensions.md)，机器可读格式见：

- [pi-studio.extension.schema.json](../schemas/pi-studio.extension.schema.json)
- [pi-studio.extension.integrity.schema.json](../schemas/pi-studio.extension.integrity.schema.json)
- [pi-studio.extension.registry.schema.json](../schemas/pi-studio.extension.registry.schema.json)
- [pi-studio.extension.install-state.schema.json](../schemas/pi-studio.extension.install-state.schema.json)

## 1. 设计原则

扩展发行层遵循五条规则：

1. **先隔离，再验证**。任何目录、ZIP、HTTPS、GitHub 或 registry 来源都先进入 quarantine，完整校验后才进入受管目录。
2. **代码、状态、数据分离**。版本代码、安装历史和扩展运行数据不混在同一个目录，也不写在项目仓库里。
3. **版本不可变**。同一扩展版本不允许静默替换为不同文件；发布新内容必须提升 `version`。
4. **权限变化必须重新确认**。升级只增加或保留权限时，新增权限必须由用户再次明确接受。
5. **完整性与身份分开确认**。SHA-256 验证文件是否完整，Ed25519 签名再绑定扩展 ID、版本、发布者和内容树；新公钥必须由用户确认指纹。

扩展格式不是 npm 包的替代品。Pi Studio 只接受 `pi-studio.extension.json` 所声明的能力，不执行 `postinstall`，也不允许包内符号链接。

## 2. 包格式

规范发布文件：

```text
pi-metrics-1.0.0.pi-extension.zip
├── pi-studio.extension.json
├── extension.mjs
├── README.md
├── LICENSE
├── signature.json
└── integrity.json
```

`integrity.json` 由打包工具生成：

```json
{
  "schemaVersion": 1,
  "algorithm": "sha256",
  "files": [
    {
      "path": "extension.mjs",
      "sha256": "8f...",
      "size": 2048
    }
  ]
}
```

约束：

- 文件路径必须是相对 POSIX 路径。
- 拒绝绝对路径、反斜杠、`.`、`..`、重复路径以及文件/目录同名冲突。
- 拒绝符号链接、加密 ZIP、分卷 ZIP 和 ZIP64。
- 默认上限：包 50 MiB、解压总量 100 MiB、单文件 25 MiB、最多 2048 项。
- 支持 ZIP `store` 和 `deflate`，其他压缩算法拒绝。
- 每个文件都校验长度、CRC-32 与 SHA-256。
- `integrity.json` 必须覆盖除自身以外的全部文件；多一个或少一个都会失败。
- 打包会忽略 `.git`、`.data`、`.pi-studio`、`release/`、`SHA256SUMS`、`*.pi-extension.zip` 和 `node_modules/.cache`。

压缩包可以直接在根目录放文件，也可以只包含一个顶层目录。后者适合 GitHub 自动生成的源码 ZIP 或系统“压缩文件夹”功能。

## 3. Manifest 发行字段

运行时最小清单仍然只需要 `format`、`id`、`name`、`version`、`permissions` 和 `contributes`。正式发行建议补齐：

```json
{
  "format": 1,
  "id": "pi-metrics",
  "name": "Pi Metrics",
  "version": "1.0.0",
  "author": "huangrx6",
  "publisher": "huangrx6",
  "license": "MIT",
  "repository": "https://github.com/huangrx6/pi-metrics",
  "engines": {
    "piStudio": ">=0.0.3 <0.2.0"
  },
  "keywords": ["metrics", "observability"],
  "icon": "assets/icon.png",
  "readme": "README.md",
  "requires": [],
  "permissions": ["ui.commands", "ui.panels"],
  "contributes": {}
}
```

规则：

- `version` 必须是完整语义化版本。
- `publisher` 缺失时发行工具回退到 `author`；两者都没有会拒绝发行。
- `repository`、`homepage` 只能使用无内嵌凭据的 HTTPS URL。
- `engines.piStudio` 使用语义化版本范围；不兼容时安装器在激活前拒绝。
- `icon`、`readme` 是包内相对路径，对应文件必须存在。
- `requires` 使用稳定扩展 ID。用户扩展只能依赖 `builtin:` 或 `user:`，项目扩展还可依赖同一工作区的 `project:`；安装器拒绝缺失依赖和循环依赖。

## 4. 作者工具

Pi Studio 仓库提供无 Electron 依赖的 CLI：

```sh
node tools/cli/pi-studio-extension.mjs validate examples/extensions/agent-starter
node tools/cli/pi-studio-extension.mjs pack examples/extensions/agent-starter --out release
```

完整命令：

```text
pi-studio-extension validate <目录> [--scope user|project] [--json]
pi-studio-extension keygen [--out <目录>] [--force] [--json]
pi-studio-extension sign <目录> --private-key <文件> [--scope user|project] [--json]
pi-studio-extension verify <目录> [--public-key <文件>] [--publisher <名称>] [--json]
pi-studio-extension pack <目录> [--out <文件|目录>] [--force] [--json]
pi-studio-extension checksum <扩展包>
pi-studio-extension entry <目录|扩展包> --download-url <HTTPS URL> [--out <文件>]
pi-studio-extension publish <目录> [--tag <tag>] [--repo owner/repo] [--out <目录>]
    [--notes <文件>] [--allow-dirty] [--dry-run] [--json]
pi-studio-extension init <目录> [--id <id>] [--name <名称>] [--publisher <发布者>]
```

### 新建扩展

```sh
pi-studio-extension init ~/Code/pi-metrics \
  --id pi-metrics \
  --name "Pi Metrics" \
  --publisher huangrx6
```

`init` 生成安全的最小 UI 扩展、manifest、README 和 `.gitignore`。需要 Agent tool 时参考 [agent-starter](../examples/extensions/agent-starter)。

### 发布者签名

```sh
pi-studio-extension keygen --out ~/.pi-studio/keys
pi-studio-extension sign . --private-key ~/.pi-studio/keys/publisher-private.pem
pi-studio-extension verify . --public-key ~/.pi-studio/keys/publisher-public.pem
```

`signature.json` 只保存公钥和签名，不包含私钥。签名排除 `signature.json` 与 `integrity.json`，绑定 manifest 的 `id`、`version`、`publisher` 与精确内容树。`sign` 完成后会重新生成 `integrity.json`；`verify` 不带外部公钥时只能证明包内自洽，带公钥并指定 publisher 时才确认发布者身份。私钥不得位于扩展目录内。

### 校验与打包

```sh
pi-studio-extension validate .
pi-studio-extension pack . --out release --json
```

打包是确定性的：文件排序固定，ZIP 时间戳固定，因此相同文件会得到相同包摘要。把输出的 `sha256` 写入 registry 或发布说明。

### 发布到 GitHub Release

```sh
git add .
git commit -m "release: v0.1.0"
pi-studio-extension publish . \
  --repo owner/pi-metrics \
  --tag v0.1.0 \
  --notes RELEASE.md
```

`publish` 会：

1. 重新打包并生成 `SHA256SUMS`。
2. 要求 Git 工作区干净；仅允许显式传入 `--allow-dirty`。
3. 读取当前 `HEAD` 作为 release target。
4. 调用已登录的 GitHub CLI `gh release create`。
5. 同时上传 `.pi-extension.zip` 和 `SHA256SUMS`。

可先检查命令而不发布：

```sh
pi-studio-extension publish . --repo owner/pi-metrics --tag v0.1.0 --dry-run
```

## 5. 安装来源

| 来源 | 示例 | 外部完整性 |
| --- | --- | --- |
| 本地目录 | `/Users/me/pi-metrics` | quarantine 内重新生成 |
| 本地包 | `./release/pi-metrics-1.0.0.pi-extension.zip` | 包内 integrity |
| HTTPS 包 | `https://host/pi-metrics.zip#sha256=<digest>` | 必须提供预期 SHA-256 |
| GitHub Release | `github:owner/repo@v1.0.0` | Release asset digest 或 checksums 文件 |
| GitHub tag/commit | `github:owner/repo@<tag-or-40-char-sha>` | 固定到 40 位 commit SHA |
| Registry | `registry:pi-metrics@1.0.0` | Registry 中必须提供 SHA-256 |

远程来源禁止 `http://`，测试环境必须显式允许 loopback。重定向到非 HTTPS 地址会失败。

### GitHub 来源规则

优先查找同名 Release：

- 必须恰好有一个 `.pi-extension.zip` asset。
- 优先使用 GitHub API 的 `digest: sha256:...`。
- 没有 digest 时查找 `SHA256SUMS` 或 `checksums.txt`。
- 没有外部摘要的 Release asset 会被拒绝。

Release 不存在时，tag 先解析成固定 commit SHA，再下载 `codeload.github.com/.../zip/<sha>`。这条回退路径没有 Release 发布者摘要，依赖 commit SHA 的内容寻址和 HTTPS；正式分发优先使用 Release。

### Registry 来源规则

配置 registry URL 后，`registry:id` 会选择适用于当前 Pi Studio、不是 deprecated、默认排除 prerelease 的最高版本。显式写 `registry:id@version` 时只接受该版本。

Registry 是静态 JSON，不需要执行服务器端代码：

```json
{
  "schemaVersion": 1,
  "name": "Pi Studio Community",
  "updatedAt": "2026-10-29T00:00:00.000Z",
  "extensions": [
    {
      "id": "pi-metrics",
      "name": "Pi Metrics",
      "publisher": "huangrx6",
      "publisherKey": "<Base64 Ed25519 SPKI 公钥>",
      "publisherKeyId": "sha256:<64 lowercase hex>",
      "repository": "https://github.com/huangrx6/pi-metrics",
      "versions": [
        {
          "version": "1.0.0",
          "piStudio": ">=0.0.3 <0.2.0",
          "download": "https://github.com/huangrx6/pi-metrics/releases/download/v1.0.0/pi-metrics-1.0.0.pi-extension.zip",
          "sha256": "<64 lowercase hex>",
          "size": 12345,
          "permissions": ["ui.commands", "ui.panels"]
        }
      ]
    }
  ]
}
```

生成条目：

```sh
pi-studio-extension entry ./release/pi-metrics-1.0.0.pi-extension.zip \
  --download-url https://github.com/huangrx6/pi-metrics/releases/download/v1.0.0/pi-metrics-1.0.0.pi-extension.zip \
  --out registry-entry.json
```

完整示例见 [registry.example.json](../examples/extensions/registry.example.json) 与 [registry-entry.json](../examples/extensions/registry-entry.json)。

`publisherKey` 是 registry 对外声明并由安装器核对的外部公钥。`publisherKeyId` 必须与公钥的 SHA-256 SPKI 指纹一致。`pi-studio-extension entry` 会从已签名扩展自动写入这两个字段；没有声明外部公钥的来源仍可安装未签名包，但 UI 会明确显示“未验证发布者身份”。

## 6. 安装、升级、回滚与卸载

### 两阶段安装

```text
source
  → resolve
  → quarantine
  → archive/path/symlink/limit validation
  → manifest/runtime/UI validation
  → Pi Studio compatibility
  → permission diff
  → external SHA-256
  → per-file integrity
  → Ed25519 signature and publisher-key check
  → install preview
  → user consent
  → atomic activate
```

`prepare()` 只返回预览，不改变活动版本。UI 应展示：

- ID、名称、版本、publisher、来源和 resolved ref。
- executable 是否为 Agent extension。
- 全部权限与 `addedPermissions`。
- `signatureStatus`、公钥指纹、发布者是否已在本机受信任，以及是否需要新 key 确认。
- archive SHA-256 与 tree SHA-256。
- 当前已安装版本和是否升级。

`installPrepared()` 必须收到 `acceptedPermissions`。新增权限不完整时返回
`PERMISSION_CONSENT_REQUIRED`；新增 `providerAccess` 必须逐项收到
`acceptedProviderAccess`；新增依赖必须收到 `acceptedRequirements: true`；
纯声明式 UI 升级为可执行代码时必须收到 `acceptedExecution: true`。任何一项未确认
都不会切换活动版本。项目扩展还应在运行时保持默认未信任，直到用户显式信任。

带有未信任公钥的有效签名还必须收到 `acceptedPublisherKey: true`。安装器会在同一
事务内重新校验签名和信任库；预览后被篡改、替换公钥，或预览后公钥被撤销，都会
分别返回 `SIGNATURE_CHANGED` 或 `REVOKED_PUBLISHER_KEY`。已经受信任的公钥不需要
重复确认。撤销只影响后续安装，不会静默卸载已安装扩展。

安装预览同时绑定 `scope` 与规范化后的工作区路径。最终安装必须使用相同目标，否则返回 `TARGET_MISMATCH`，防止用户在预览全局安装后改选项目范围，或把项目预览切换到另一个工作区。预览失败不会消耗 token；权限或依赖错误修正后可以使用同一预览重试。

### 目录布局

用户扩展代码：

```text
<userData>/extensions/<id>/<version>/
<userData>/extensions/<id>/current.json
```

项目扩展代码：

```text
<workspace>/.pi-studio/extensions/<id>/<version>/
<workspace>/.pi-studio/extensions/<id>/current.json
```

安装状态与数据：

```text
<userData>/extension-publishers.json
<userData>/extension-state/user/<id>.json
<userData>/extension-state/project-<workspace-hash>/<id>.json
<userData>/extension-data/user/<id>/
<userData>/extension-data/project-<workspace-hash>/<id>/
```

`extension-publishers.json` 保存用户确认过的发布者公钥指纹与撤销状态，权限为私有文件；它不包含签名私钥。

项目代码可以随工作区同步，但项目扩展的安装状态和运行数据始终放在 Pi Studio userData，不写入项目仓库。

### 原子升级

1. 在 `<id>/.staging-<uuid>` 创建完整副本。
2. 再次验证 manifest、兼容性、路径和文件摘要。
3. 版本目录不存在时才 rename 到 `<id>/<version>`。
4. 新版本与旧版本同时保留。
5. 原子写入安装状态。
6. 原子更新 `current.json`。
7. 任一步失败都清理 staging；状态或指针失败时恢复旧状态。

同一 `id@version` 已存在且 tree SHA-256 不同会返回 `VERSION_COLLISION`。不能通过覆盖同版本来“偷偷更新”已安装扩展。

默认不允许安装低于当前活动的版本。`rollback()` 使用已保留的历史版本切换活动指针，不需要重新下载。

`prepare()` 和 `installPrepared()` 都会执行版本不可变与降级检查，避免用户确认一个最终必然失败的安装。相同版本、相同 tree SHA-256 的安装是幂等操作：返回 `alreadyInstalled: true` 或 `contentChanged: false`，不重复追加版本历史，也不会撤销已经建立的项目信任。

项目扩展一旦升级或回滚到不同的 tree SHA-256，Studio 会立即撤销旧内容的信任。依赖它的启用扩展会因依赖未受信任而停止加载，直到用户重新审查新内容并手动信任。安装事务成功但状态或指针恢复失败时返回 `TRANSACTION_RECOVERY_FAILED`，提示用户重启并检查状态，而不是继续以不确定状态运行。

### 卸载

- 默认只删除代码和安装状态，保留扩展数据。
- `preserveData: false` 才删除数据目录。
- 代码、状态、数据分别删除，任一目录都不会放到扩展代码根目录中。

## 7. 后端 API

Electron 主进程创建服务时应传入 `app.getPath('userData')`、`app.getVersion()` 和现有运行时 manifest 校验器：

```js
const {
  createExtensionDistributionService,
} = require("./services/extension-distribution.cjs");
const { normalizeManifest } = require("./services/studio-extensions.cjs");

const installs = createExtensionDistributionService({
  userDataPath: app.getPath("userData"),
  appVersion: app.getVersion(),
  normalizeManifest,
  registryUrl: settings.extensionRegistryUrl,
});

const preview = await installs.prepare(source, { scope, cwd });
// Renderer 展示 preview，并收集 acceptedPermissions。
const installed = await installs.installPrepared(preview.token, {
  scope,
  cwd,
  acceptedPermissions,
  acceptedPublisherKey: preview.requiresPublisherTrust,
  trusted: scope === "project" ? false : true,
});
```

公开方法：

```text
prepare(source, options)
installPrepared(token, options)
inspectSignature(directory, scope, resolved)
publisherTrustSnapshot()
revokePublisherKey({ publisher, keyId })
rollback(id, options)
uninstall(id, options)
getInstalled(id, scope, cwd)
listInstalled(scope, cwd)
resolveActiveDirectory(id, scope, cwd)
disposePrepared(token)
prunePrepared()
pack(directory, options)
loadRegistry(location)
```

错误对象包含稳定的 `code`：

```text
PERMISSION_CONSENT_REQUIRED
INCOMPATIBLE_PI_STUDIO
MISSING_REMOTE_INTEGRITY
INTEGRITY_MISMATCH
VERSION_COLLISION
VERSION_DOWNGRADE
PREPARED_EXPIRED
PREPARED_CLAIMED
INSTALL_BUSY
TARGET_MISMATCH
PUBLISHER_MISMATCH
PUBLISHER_TRUST_REQUIRED
REVOKED_PUBLISHER_KEY
SIGNATURE_CHANGED
PACKAGE_CHANGED
TRANSACTION_RECOVERY_FAILED
```

### 运行时接入点

Studio 运行时已经通过安装状态解析 `<id>/<activeVersion>/pi-studio.extension.json`，并只把状态中的受管 `dataPath` 传给 `activate({ dataDirectory })`。版本代码目录不承载运行数据。

renderer 使用以下 IPC：

- `pi:extension-prepare`：隔离来源并返回预览。
- `pi:extension-install`：确认权限后原子安装。
- `pi:extension-dispose`：释放未提交的 quarantine。
- `pi:extension-rollback`：切换到保留的上一版本。
- `pi:extension-publisher-trust`：读取本机发布者公钥信任库。
- `pi:extension-publisher-revoke`：撤销一个发布者公钥指纹。

安装、回滚和卸载后会关闭对应扩展的实时数据 view，并从 SQLite 状态重建运行时；不需要退出应用。

## 8. 安全边界

已经实现：

- quarantine 后验证，失败自动清理。
- 目录和 ZIP 路径越界检查。
- 包内符号链接拒绝。
- ZIP CRC、长度、逐文件 SHA-256 校验。
- Ed25519 `signature.json` 校验扩展 ID、版本、publisher、公钥指纹和精确内容树。
- registry 外部 `publisherKey` 与包内签名交叉校验；未知公钥必须显式信任，撤销公钥禁止安装。
- 下载大小、解压总量、单文件数量和大小限制。
- 远程 URL 的 HTTPS、重定向与外部摘要要求。
- GitHub Release digest/checksums 校验；tag 固定到 commit SHA。
- manifest 协议、权限、贡献 ID、UI action 和 runtime entry 校验。
- `engines.piStudio` 兼容检查。
- 同版本不可变、权限扩张重新确认、升级失败恢复和版本回滚。
- 安装状态与临时目录使用私有权限。
- 同一扩展安装串行锁，避免并发写入状态。
- 安装预览与安装目标绑定，防止跨范围或跨工作区错装。

尚未提供：

- 透明度日志或 Sigstore/DSSE 身份链。当前 Ed25519 能证明后续签名来自同一个本机受信任公钥，但首次信任仍由用户核对指纹完成。
- 系统级进程沙箱。Agent extension 一旦被信任，仍拥有 Node 主进程能力。
- 自动后台升级。升级必须重新走 `prepare`、权限确认和激活流程。
- ZIP64、加密 ZIP 或不可信自定义压缩算法。

正式 registry 应同时发布包 SHA-256、外部 Ed25519 公钥和指纹，并绑定受控 HTTPS 发布域与持续审计。SHA-256 解决下载完整性，Ed25519 解决发布者身份连续性，二者不能互相替代。

## 9. 作者发布检查清单

- `id` 永久稳定，发布内容变化必须提升 `version`。
- manifest 只声明实际需要的权限。
- 同时声明 `publisher`、`license` 与 `repository`。
- 使用独立 Ed25519 私钥签名；私钥不进入仓库、扩展目录、日志或 CI artifact。
- registry 条目同时写入包 SHA-256、`publisherKey` 与 `publisherKeyId`。
- Agent extension 在真实 Durable session 中验证 tools、commands、sections、hooks 或 tasks。
- UI 只使用 declarative content 和允许的 action。
- 不依赖本机绝对路径、`.data`、`~/.pi` 或项目外文件。
- 运行 `validate`、`sign`、`verify --public-key`、`pack`，在干净环境安装生成的 ZIP。
- 检查升级新增权限提示，确认数据目录跨版本保留。
- 发布 Release 同时上传 `SHA256SUMS`。
- 为 registry 条目填入最终包的 SHA-256 与大小。
