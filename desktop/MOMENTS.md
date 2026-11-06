# 可复用的朋友圈工具

通过当前官方 Linux 微信的可见界面发布，支持纯文字和带文案的 1–9 张 PNG/JPEG 图片。文案最多 1000 字。实机界面为微信 4.1.13.26；纯文字使用相机按钮的右键菜单。视频暂不支持。

工具没有定时器，也没有接入人物聊天或生活心跳。自主发布保持关闭；由明确授权的本地调用或 Codex 桌面 MCP 调用执行。

## 调用

在项目目录运行，JSON 从标准输入读取，文案不会经过 shell 拼接：

```sh
python3 desktop/moments.py post <<'JSON'
{
  "requestId": "example-unique-post-id",
  "text": "这会儿有点想吃冰淇淋",
  "images": ["/absolute/path/photo.png"],
  "publish": false
}
JSON
```

`images` 可省略，表示纯文字。默认 `publish:false` 会打开编辑页、填写并核对文案、保存真实预览截图，随后取消并丢弃本次预览，不留下客户端草稿。确认内容后，以同一 `requestId`、相同文案和图片调用 `publish:true`，才执行一次发表。

```sh
python3 desktop/moments.py status <<'JSON'
{"requestId":"example-unique-post-id"}
JSON
```

同一 `requestId` 对应同一份内容。成功或结果不明后重复调用只返回原回执，不再次发表。预览可升级为发表；改变内容需要新的 ID。`status` 仅读取本地记录。

现有 `wechat_desktop` MCP 同时提供 `moments_post` 和 `moments_status`，参数与上面相同。聊天发送操作员不获得这两个工具。MCP 客户端如缓存工具列表，需要重新连接该 MCP 服务。

## 执行与结果

- 使用现有桌面与 OCR 容器，不新建数据库收件器、不重新提取密钥、不使用微信私有发布协议。
- 整个发布流程占用现有界面锁。聊天收件继续，聊天发送等待；开始前发现正在发送、通道暂停或已有朋友圈草稿时不覆盖它。
- 图片先复制到本次操作目录，记录 SHA-256，并检查文件能解码。文案通过编辑框复制读回核对；发布范围须在界面显示为「公开」，不自动修改隐私设置，不添加定位、提醒或第三方身份。
- 点击前持久化 `publishing`，只点击一次。看到自己发布的文案出现在朋友圈顶部才记 `published`；这是可见界面确认，不伪造微信服务器 ID。
- `uncertain` 表示已尝试发表但没有明确回执，须人工看现场，不自动重发。中途退出留下的 `publishing` 也按结果不明处理。
- 账号安全提示保留现场并暂停相关自动操作，通过已配置的外部通知适配器告警。

回执保存于 `~/.wechat-codex-desktop/moments/<requestId>.json`，实际图片副本和截图在 `~/.wechat-codex-desktop/exchange/moments/<requestId>/`。`published:true` 才表示已确认发布；`preview`、`busy`、`paused`、`failed`、`blocked`、`not_sent`、`uncertain` 都不等于成功。`not_sent` 是客户端明确提示未发送，不自动重试。

当前未完成成功发表后的真机回执验收，自主发布保持关闭；本工具不列为已验收的自动朋友圈功能。

离线验证：

```sh
python3 tests/desktop-moments.test.py
python3 tests/desktop-database-operator.test.py
python3 tests/desktop-security.test.py
```
