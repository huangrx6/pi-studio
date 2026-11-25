# Pi Studio 官方插件源

[`registry.json`](registry.json) 是插件市场「官方精选」的目录。Pi Studio 发布桌面包时会把本目录打包到应用资源中。

- [Excalidraw](packages/excalidraw/README.md) 按会话保存可编辑画布。
- [任务看板](packages/task-board/README.md) 在所有会话间共享全局任务。

每个插件在 `packages/` 下有独立目录，包含清单、README、许可证、图标及它声明的资源。将一个插件目录或该目录内容打成的 `.pi-plugin.zip` 交给 Pi Studio，即可走本地安装流程。

更新官方包时，先验证包和附带扩展，再更新 `registry.json` 中对应条目的版本。`packagePath` 相对于目录文件，`sha256` 使用 `pi-studio-plugin validate --json` 输出的 `contentHash`。安装时会用这个摘要校验整个插件目录。

完整的插件约定见 [Pi Studio 插件指南](../../docs/guides/plugins.md)。
