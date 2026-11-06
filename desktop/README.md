# Linux 个人微信收发

此目录实现阮阮的官方 Linux 微信桌面通道：**只读读库收件，审核后 GUI 发送，以数据库回执确认**。完整安装顺序见 [部署说明](../docs/DEPLOYMENT.md)，人物生成、审稿与后台模型调用见 [架构图](../docs/ARCHITECTURE.md)。

## 当前实现

- 入站事件按真实账号、会话和数据库来源 ID 路由与去重，持久游标在应用接受后提交；首次准备不回答旧历史，重启不把水位之后的新消息吞为背景。
- 私聊按人隔离，群聊按真实群 ID 保存共同公开上下文；原生提及、引用和活跃对话决定参与候选。普通邮箱、复制的 `@` 和表情按正文理解。同发言者静默 2 秒后合并，群内其他成员独立计时。
- 文字、图片、表情、视频、引用与语音随实际可取得的来源处理。图片优先原图、缺失时标注真实缩略图；语音优先微信已有转写，缺失时可配置 ASR。未知内容保持未知，不用 XML 或卡片猜画面、金额或领取结果。
- 人物生成与独立审稿共享同一份身份、关系、生活、记忆和媒体资料。新输入可使旧草稿失效；未通过审核的候选不会进入发送器。
- 发送持有 UI 锁和租约，核对目标、完整输入和原生提及。特殊字符昵称可结合真实成员表、候选唯一性及输入框完整 Unicode 名称核验；不能确认的目标不发送。
- 图片、视频先发送并确认，随后由配文或单独原生提及通知目标成员。已确认附件不会因为后续提醒失败而重发。
- 发送一次后核对对应会话中新出现的外发记录、正文/附件摘要、`atuserlist` 和服务器消息 ID。结果不明时保留交付并暂停，不重复点击；回执不表示对方已读。

人物入口仅用于人物聊天，不把昵称、群消息、引用或模型输出当作服务器操作授权。管理员身份绑定用于核实身份，**不是联系人白名单**；数据库路由同步会启用多用户处理。

## 进程与数据

| 组件 | 职责 |
| --- | --- |
| `ruanruan-wechat-direct.service` → `ruanruan-wechat-gui.service` | 安装本项目直连规则，再启动官方客户端桌面 |
| `wechat-desktop-runtime.service` | 本地模型会话与工具编排 |
| `wechat-desktop-bridge.service` | 人物任务、持久队列与发送交付 |
| `wechat-desktop-database.service` | 独立读库收件线程与串行 GUI 发送 |
| `wechat-desktop-manual.socket` / `wechat-desktop-manual@.service` | 浏览器交互接管与共享 UI 锁 |
| `wechat-desktop-repair.service` | 可选隔离自动修复 |

默认数据根是部署用户的 `$HOME/.wechat-codex-desktop`，Python 工具可用 `WCB_DESKTOP_DATA` 指定。主要文件：

| 路径（相对数据根） | 内容 |
| --- | --- |
| `bridge.json`、`database.json` | 路由、身份绑定与读库配置 |
| `app/` | 会话、任务、记忆、身份、人物配置与日志 |
| `bridge/` | 持久收发队列、租约、暂停与回执 |
| `database-state/` | 游标、准备结果、恢复记录和账号告警 |
| `transport-health.json` | 接收进度、发送阻塞及恢复状态 |
| `exchange/` | 入站媒体与临时界面文件 |
| `auto-repair/` | 隔离修复队列、证据和结果 |

读库复用固定版本上游的 SQLCipher、消息解析和媒体解码，不启动其聊天服务。出处与许可见 [UPSTREAM.txt](db-worker/UPSTREAM.txt)。读库容器关闭网络，以只读方式挂载已核实账号目录，使用读取客户端密钥所需的权限，不修改微信源库、客户端或进程内容。独立 OCR 进程使用 RapidOCR + ONNX Runtime，不挂载微信数据库。

## 首次准备与启用

先完成 [部署说明](../docs/DEPLOYMENT.md) 中的依赖、路径/网卡适配、禁用配置、接管 socket 和桌面启动。真人扫码登录并确认人物微信号、管理员微信号、唯一备注和当前会话后，再运行安装器与准备检查：

```bash
python3 desktop/install_database_transport.py \
  --account-wechat-id "$RR_ACCOUNT_WECHAT_ID" \
  --owner-wechat-id "$RR_OWNER_WECHAT_ID"
python3 desktop/database_operator.py --check
python3 desktop/database_operator.py --prepare
```

安装器自动准备 reader 构建文件。`--check` 只查配置；`--prepare` 访问真实数据库与当前界面，保持收发禁用，同步联系人/群路由、保存身份绑定和水位，不导入入站任务或调用对话模型。未导入的群背景留待正式启用。

完成身份核对与服务安装后才执行 `desktop/activate.mjs --transport database`。该命令启用自动回复且解除应用暂停，不能当成常规重启命令；完整参数和先后顺序以部署说明为准。

## 状态、人工接管与故障

在项目目录查看状态及日志：

```bash
systemctl --user status wechat-desktop-runtime.service wechat-desktop-bridge.service wechat-desktop-database.service --no-pager
python3 desktop/wechat_gui.py bridge_status
journalctl --user -u wechat-desktop-database.service -n 40 --no-pager
python3 desktop/wechat_gui.py screenshot
```

截图输出在本机数据目录，包含私人会话，不上传到源码仓库。桌面网页登录通过 localhost SSH 隧道或可信 HTTPS 访问。交互连接在允许输入前取得 UI 锁；最后一个连接关闭后释放。最小化页面不等于退出，`#shared` 也不保证纯观看。退出接管后检查在途任务状态；异常残留人工 hold 经现场核查后可运行：

```bash
python3 desktop/manual_control.py release
```

此操作不解除账号安全锁或不确定发送。账号验证、退出或异常登录时保留现场，由真人处理；程序不点击重登、验证或申诉。普通脚本异常可由退避重启恢复，发送后的不明结果只核对回执。凭据与外部通知接入按部署配置管理；本地告警记录存在不代表外部消息已送达。

`database.json` 的 `modelRecovery.enabled` 控制受限视觉恢复：最多 4 次判断，每次 120 秒，模型不改正文、身份或记忆，所有动作仍由宿主校验。`autoRepair.enabled` 与独立修复服务控制隔离修复：模型分析证据、修改副本，验证并确认线上基线未变化后等待空闲部署。两者都会产生远程模型调用，日常 OCR 不会。

日志区分收件轮询/排队、生成、审查、界面编排、OCR 和回执阶段。`totalMs` 包含子阶段，不能把 OCR/RPC 等子项再相加，也不能把生成结束当成微信已送达。真实聊天、语音、媒体和客户端兼容性由部署者实聊确认；离线测试不代表端到端验收。

明确调用的朋友圈预览/发布工具见 [MOMENTS.md](MOMENTS.md)，它不是自动聊天或心跳的自主发布功能。
