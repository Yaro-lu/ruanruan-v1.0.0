# 阮阮部署说明 / Deployment

本仓库部署 Linux 官方个人微信人物聊天：只读本地数据库收件，经过生成与独立审稿，通过客户端 GUI 发送。支持私聊、群聊、记忆与关系状态、媒体、可选语音转写和人物生活心跳。功能与模型调用见 [架构说明](ARCHITECTURE.md)。

安装顺序是：**本机检查 → 编译与离线验证 → 禁用状态的配置 → 登录桌面 → 真人扫码及身份核对 → prepare → 启用自动收发**。模板中的主机路径、网卡、地址和资源限制需要适配；私有素材与凭据不在仓库，不是零配置安装包。

## 1. 依赖与主机检查

先读 [根 AGENTS.md](../AGENTS.md)、[桌面 AGENTS.md](../desktop/AGENTS.md) 和 [桌面运行说明](../desktop/README.md)。需要 Linux、Node.js **>= 22.13.0**、npm、Git、Python **>= 3.11**、Docker Engine/Compose、systemd 系统及用户服务、`flock`、`ip`、`iptables`、SSH，以及兼容的 Codex CLI/app-server。模型走 API 时仍需本地 app-server 编排。当前容器与原生依赖主要面向 x86_64；其他架构须先核对镜像、SQLCipher、sqlite-vec、OCR 和音频依赖。

```bash
node --version
npm --version
python3 --version
codex --version
docker version
docker compose version
systemctl --user is-system-running
ip -4 route show table main
ip -4 rule show
docker ps --format '{{.Names}}'
free -h
df -h
```

部署用户须能访问 Docker 和用户 systemd。需要退出 SSH 后继续运行时，为实际部署用户配置 `loginctl enable-linger`；不要将用户服务装进 root 家目录。使用 nvm 等安装 Node 时，服务与任务启动器必须能找到同一版本。GUI、读库、OCR、聊天和后台任务需共同核算内存，单元限额不是整机峰值保证；保留其他项目的容器、网络和模型代理。

## 2. 检出、编译与离线验证

仓库地址由所有者提供，使用 SSH 或本机 Git 凭据，不把 token 写进 URL。

```bash
git clone <YOUR_PRIVATE_REPOSITORY_URL> ruanruan
cd ruanruan
export RR_ROOT="$(pwd -P)"
export RR_DATA="$HOME/.wechat-codex-desktop"
export WCB_DESKTOP_DATA="$RR_DATA"
export WCB_DESKTOP_CONFIG="$RR_DATA/bridge.json"
export WCB_DATA_DIR="$RR_DATA/app"
umask 077
npm ci
npm run build:desktop
```

`npm ci` 的 postinstall 生成 `dist/`；`build:desktop` 生成 `dist-desktop/`。按运行时 unit 的 `WCB_BUILD_DIR` 保留所需产物；不复制旧机器的运行目录或账号数据库到源码。

以下测试使用模拟对象和临时文件，不登录微信、不请求真实模型、不发送消息：

```bash
RR_CHECK_DATA="$(mktemp -d)"
WCB_DATA_DIR="$RR_CHECK_DATA" node --test \
  dist-desktop/tests/character-models.test.js \
  dist-desktop/tests/desktop-channel.test.js \
  dist-desktop/tests/desktop-database.test.js
python3 tests/desktop-security.test.py
python3 tests/desktop-model-recovery.test.py
python3 tests/desktop-manual-control.test.py
python3 tests/desktop-manual-resume.test.py
python3 tests/desktop-bootstrap.test.py
```

检查后可清理本次新建的 `RR_CHECK_DATA`。其他脚本先读用途再运行，不能把真实模型采样或生产发送脚本当作离线测试。

## 3. 本机配置与人物提示词

下面仅用于**全新数据目录**；已有安装先备份并逐项合并，保留身份、会话、游标和暂停状态。

```bash
install -d -m 700 "$RR_DATA" "$RR_DATA/app" "$RR_DATA/app/logs" \
  "$RR_DATA/app/providers" "$RR_DATA/bridge" "$RR_DATA/config" "$RR_DATA/exchange"
cp desktop/bridge.example.json "$RR_DATA/bridge.json"
cp character-models.example.json "$RR_DATA/app/providers/character-models.json"
ln -s "$RR_ROOT/personas/ruanruan/GENERATE.md" "$RR_DATA/app/GENERATE.md"
ln -s "$RR_ROOT/personas/ruanruan/REVIEW.md" "$RR_DATA/app/REVIEW.md"
chmod 600 "$RR_DATA/bridge.json" "$RR_DATA/app/providers/character-models.json"
```

把 `bridge.json` 的 `exchangeDirectory` 和 `queueDirectory` 改为本机绝对路径；`enabled` 保持 `false`，contacts 暂为空。数据库模式准备阶段会同步真实联系人/群路由并设置 `multiUser=true`；管理员绑定核实身份，**不是收件白名单**。如需只回复管理员，必须先实现并验证明确过滤，不能靠 `multiUser=false` 假装隔离。

`GENERATE.md` 定义人格与表达，`REVIEW.md` 定义审稿约束。可以按部署角色调整，但不把密码、API Key 或服务器权限写入人物提示词，也不因改提示词清空聊天。

[角色配置示例](../character-models.example.json) 将生成、审稿、修稿分开：

| 职责 | model | reasoningEffort | serviceTier |
| --- | --- | --- | --- |
| generation | `gpt-6-sol` | `low` | `default` |
| review | `gpt-6-sol` | `low` | `default` |
| repair（正文修稿） | `gpt-6.1-sol` | `medium` | `default` |

供应方须支持所选模型；不可用时明确报告。人物模型可使用已登录的 Codex 或配置 API。API 示例保存到 `app/providers/llm.json`：

```json
{
  "active": "openai",
  "scope": "character",
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-6-sol",
      "reasoningEffort": "low",
      "useRoleModels": true
    }
  }
}
```

Key 仅保存到本机 `app/providers/openai.json`，格式 `{"apiKey":"本机填写"}`；需要模型代理时另加 `proxyUrl`，权限设为 `0600`。`llm.json` 不接受内嵌 Key。Codex 后端配置为 `{"active":"codex","providers":{}}`，由真人完成运行用户的 Codex 登录。

```bash
node scripts/llm-backend.mjs --desktop status
```

该命令只查配置，不验证模型可用性。模型脚本默认读取 `$HOME/.wechat-codex-desktop/app`，`WCB_DATA_DIR` 可指定实例；`use <已配置供应方>` 只修改选中实例，`scope: character` 同步该实例心跳后端。角色模型、额外 ASR/生图/embedding 和后台模型的权限及额度分别核对，不自动换供应方或计费通道。

## 4. 桌面、直连与人工接管

安装前逐项适配：

- `desktop/compose.yaml` 的挂载、UID/GID、监听地址、子网和 bridge 名。
- `desktop/direct-network.sh` 的物理出口、路由表/优先级、远程管理回程规则和 iptables backend，避免现有网段冲突。
- `desktop/*.service`、`systemd/*.service` 的项目、数据、Node 路径；`activate.mjs` 的新会话工作目录与 Windows 启动脚本的 SSH 目标。
- Python user units 的 `WCB_DESKTOP_DATA`；初装建议使用默认每用户目录 `$HOME/.wechat-codex-desktop`，并检查所有组件一致。

微信客户端经物理网卡直连，模型代理独立。只修改本项目网络，不重启整机网络或其他容器。**按 direct → gui 服务顺序启动，不直接运行 Compose 绕过直连规则。**

在私有数据根创建 `desktop.env` 并设为 `0600`，密码在本机填写：

```dotenv
PUID=<DEPLOY_USER_UID>
PGID=<DEPLOY_USER_GID>
TZ=Asia/Shanghai
CUSTOM_USER=<LOCAL_DESKTOP_LOGIN>
PASSWORD=<LOCAL_STRONG_PASSWORD>
```

建议 Compose 只发布 `127.0.0.1:3290:3000`。保留固定镜像 digest、`start-wechat.sh` 与人工接管 hook 挂载；hook 和 Selkies 不兼容时解决错误，不能跳过接管检查。

完成适配后，先安装接管 socket，再启动登录桌面：

```bash
install -d -m 700 "$HOME/.config/systemd/user"
install -m 644 desktop/wechat-desktop-manual.socket desktop/wechat-desktop-manual@.service \
  "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now wechat-desktop-manual.socket
sudo install -m 644 desktop/ruanruan-wechat-direct.service /etc/systemd/system/
sudo install -m 644 desktop/ruanruan-wechat-gui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ruanruan-wechat-direct.service ruanruan-wechat-gui.service
```

此时自动回复仍禁用。socket 文件权限需对应部署用户与容器桌面用户。

## 5. 真人登录与首次准备

在自己的电脑建立隧道，替换实际 SSH 账号/主机：

```bash
ssh -N -T -L 127.0.0.1:13390:127.0.0.1:3290 \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
  DEPLOY_USER@SERVER
```

保持隧道运行，用桌面密码访问 **http://127.0.0.1:13390/**。转发的是 HTTP，不能直接把 URL 改成 HTTPS；非 localhost 入口须配置可信 HTTPS 和 WebSocket 转发。Windows 可适配 `desktop/windows/` 的一键脚本。

真人扫描官方微信客户端二维码、完成手机确认，核对人物微信号、管理员微信号、唯一备注和当前管理员会话。账号核验、异常登录或封禁提示交真人处理，程序不点击验证、重登或申诉。核实后设置本地变量：

```bash
export RR_ACCOUNT_WECHAT_ID='<VERIFIED_CHARACTER_WECHAT_ID>'
export RR_OWNER_WECHAT_ID='<VERIFIED_OWNER_WECHAT_ID>'
export RR_OWNER_UI_LABEL='<VERIFIED_UNIQUE_REMARK>'
```

为禁用的 `bridge.json` 写入首次管理员路由：

```bash
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
p = Path(os.environ['RR_DATA']) / 'bridge.json'
d = json.loads(p.read_text())
if d.get('enabled') or d.get('contacts'):
    raise SystemExit('Existing binding: inspect and merge; do not overwrite')
owner = os.environ['RR_OWNER_WECHAT_ID']
peer = 'owner-' + hashlib.sha256(owner.encode()).hexdigest()[:16]
d.update(enabled=False, ownerPeerId=peer,
    exchangeDirectory=str(p.parent/'exchange'), queueDirectory=str(p.parent/'bridge'),
    contacts=[{'peerId':peer, 'uiLabel':os.environ['RR_OWNER_UI_LABEL'],
               'identityNote':'Operator verified WeChat ID: '+owner}])
p.write_text(json.dumps(d, ensure_ascii=False, indent=2)+'\n')
p.chmod(0o600)
PY
```

保持客户端在已核对会话，关闭交互网页释放 UI 锁，再构建只读 reader 并准备：

```bash
python3 desktop/install_database_transport.py \
  --account-wechat-id "$RR_ACCOUNT_WECHAT_ID" \
  --owner-wechat-id "$RR_OWNER_WECHAT_ID"
python3 desktop/database_operator.py --check
python3 desktop/database_operator.py --prepare
```

安装器须看见唯一已登录账号，固定拉取上游版本并自动将 `rpc.py`、`live_database.py` 加入镜像构建；版本与许可见 [UPSTREAM.txt](../desktop/db-worker/UPSTREAM.txt)。它不是登录前的通用安装器。

`--prepare` 保持自动收发禁用，同步真实路由、检查管理员会话，保存身份绑定、就绪状态和消息水位。它不导入入站任务、不调用对话模型、不发消息；未导入群背景在正式启用后补齐，水位之后的新消息留给正常收件。此步骤访问真实数据库与界面，不属于离线验证；微信源目录保持只读。

## 6. 启用与验收

使用已适配文件安装用户服务：

```bash
install -m 644 systemd/wechat-chat.slice systemd/wechat-background.slice "$HOME/.config/systemd/user/"
install -m 644 desktop/wechat-desktop-runtime.service desktop/wechat-desktop-bridge.service \
  desktop/wechat-desktop-database.service \
  "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
node desktop/activate.mjs --transport database \
  --account-wechat-id "$RR_ACCOUNT_WECHAT_ID" \
  --owner-wechat-id "$RR_OWNER_WECHAT_ID" \
  --ui-label "$RR_OWNER_UI_LABEL"
```

**activation 开始自动回复，并会解除应用暂停**；它不是常规重启命令。服务运行后，由真人发送正常聊天验收：

```bash
systemctl --user status wechat-desktop-runtime.service wechat-desktop-bridge.service wechat-desktop-database.service --no-pager
python3 desktop/wechat_gui.py bridge_status
journalctl --user -u wechat-desktop-database.service -n 40 --no-pager
```

核对实际服务器回执，不以“已点击”代替送达。停止自动收发可运行 `systemctl --user stop wechat-desktop-database.service wechat-desktop-bridge.service`；保留 runtime、客户端和数据，恢复前先核查暂停与未确认回执，再启动这两个服务。

交互网页持有共享 UI 锁，最后一个连接关闭后释放。最小化不算退出，`#shared` 不保证纯观看；接管前宜等当前回复完成，退出后查看在途任务。经现场核查可用 `python3 desktop/manual_control.py release` 释放异常残留人工 hold；它不清除账号安全锁，也不保证在途回复自动补发。

## 7. 可选能力与数据维护

| 能力 | 配置与降级 |
| --- | --- |
| 私有素材 | 素材不在仓库。将 `WCB_MEDIA_ROOT` 指向服务器真实目录，包含 `素材索引.json` 和索引中的图片/视频/表情文件；不用 Windows 映射盘。变量需覆盖 bridge 和 systemd worker，仅在 SSH shell 导出不够。缺少素材时本地检索为空，文字聊天仍可用。`scripts/refresh-local-media.mjs --root` 只更新已有本地素材索引。 |
| 语音 | reader 镜像带 ffmpeg/pilk；ASR 另需 `app/providers/asr.json` 及所选供应方配置。无服务/解码失败保持未知；转写可能有错，真实语音由真人验收。 |
| 人物心跳 | 模板 `systemd/ruanruan-heartbeat.service` 使用人物 app、desktop runtime 与同一生活账本。API 模式需 `providers/heartbeat.json`，连接/凭据从 `providers/openai-embeddings.json` 读取；本地约 7 分钟检查，模型尝试至少间隔 45 分钟、每日最多 24 次。 |
| 生图与向量检索 | 各自需要供应方和凭据，素材引用须真实存在；没有配置时明确哪些能力不可用。后台模型调用另计用量。 |
| 视觉恢复 / 自动修复 | `database.json` 的 `modelRecovery.enabled`、`autoRepair.enabled` 及修复服务控制；先验证基本收发，再按需要启用并设置资源预算。 |
| 外部通知 | 可选适配器负责账号安全和运行故障通知；在本机配置独立目的地与凭据。未接入时保留本地告警、暂停和日志，并标记外部通知不可用。投递状态须单独确认。 |
| 备份 | `scripts/backup-character-state.py` 默认仅备份人物数据根，包含 `app/character-life`；适配备份 service/timer 的实际路径和私有目的地。已有外部生活账本链接须明确纳入允许根，不能另建一本替代。SQLite 使用 backup API，默认排除结构化凭据；恢复时另配凭据。只清理该工具创建的备份，不覆盖线上数据或恢复用户已删除的旧备份。 |

首次备份及恢复演练示例（替换目的地与快照路径，再执行）：

```bash
python3 scripts/backup-character-state.py backup --desktop "$RR_DATA" --destination '<PRIVATE_BACKUP_DIRECTORY>'
python3 scripts/backup-character-state.py verify '<SNAPSHOT_DIRECTORY>'
python3 scripts/backup-character-state.py restore-drill '<SNAPSHOT_DIRECTORY>' --target '<NEW_DRILL_DIRECTORY>'
```

演练目标必须是尚不存在的新目录，不参与在线运行；校验通过后再安装已适配的备份 timer。日常用量可用 `scripts/export-api-usage.py` 从所选 app 导出；心跳记录可用 `scripts/export-heartbeat.py --once --data <APP_DIRECTORY> --output <OUTPUT_FILE>` 导出到已存在的目标父目录。它们读取本地记录，不发起模型调用。

更新前备份、编译和离线验证，等在途任务结束后只重启受影响服务。模型凭据、桌面密码、登录数据、真实聊天、截图/音频、素材、日志和备份均留在本机私有目录；私有 Git 仓库也不提交这些数据。

## 可复制的 AI 部署提示词

```text
请在当前 Linux 主机部署这个阮阮仓库，实际完成已授权、可自动化的部分。
先读 AGENTS.md、desktop/AGENTS.md、docs/DEPLOYMENT.md、desktop/README.md、package.json、Compose 和安装/服务脚本。核对本机用户、路径、Node/Codex/Python/Docker/systemd、资源、网卡和路由；模板中的旧主机值不能照搬，只操作本项目。
目标是官方个人微信客户端“只读读库收、审核后 GUI 发”的人物通道。先安装依赖、编译、运行离线测试，创建禁用配置及 GENERATE.md/REVIEW.md 链接，按 character-models.example.json 配置生成/审稿/修稿。凭据只存本机 0600 文件，不写输出或 Git。缺少素材、ASR、通知或其他可选服务时如实说明。
适配微信直连规则并保留其他容器、网络与模型代理。先安装人工接管 socket/hook，再只启动登录桌面，提供 localhost SSH 隧道或可信 HTTPS 入口。
真人扫码、手机确认和人物/管理员身份及唯一备注核对是人工步骤。复用已有可信本机资料，集中列出缺失信息，继续独立工作。登录后运行 reader 安装器，保持收发禁用执行 --prepare，保存绑定/水位后再 activate database transport。联系人路由会启用多用户处理，管理员绑定不是白名单；如果我要求仅管理员，先增加明确过滤并离线验证，不能用 multiUser=false 假装隔离。
不要调用真实模型采样、发合成测试消息、点击核验/申诉或盲目重发不确定交付；正式聊天由我验收。在授权范围内连续完成，不增加逐命令审批。
交付变更文件、本机配置与数据位置、离线结果、状态/启停/日志命令、网页入口、接管退出方法、可选能力状态及剩余人工步骤。分别报告离线验证、服务运行和真实送达；不要声称零配置或全部验收。
```

## English deployment summary

Install the official Linux personal-WeChat character channel. Use Node >= 22.13, Python >= 3.11, Docker Compose, systemd user services and a compatible Codex app-server. Sections 1–3 contain the dependency/build/offline-test commands and disabled configuration. Keep the three model roles separate and keep all credentials local.

Adapt host paths, UID/GID, interfaces, subnets, routing and units. Install the manual-control socket before starting the login desktop through direct-network → GUI services. Access it through the SSH tunnel at `http://127.0.0.1:13390/`, or configure trusted HTTPS/WebSockets for a non-localhost endpoint.

A human scans the official client's QR code and verifies both account identities and the owner's unique contact label. Populate the disabled owner route, run the reader installer (it includes the required build files), then `--prepare`. Preparation saves bindings/watermarks without ingesting tasks or sending; deferred group background is imported after activation without discarding newer messages. Activate only after verification. Route synchronization enables multiple contacts/groups; owner binding is not an intake allowlist.

Validate through normal human conversations. Check server-confirmed receipts, not clicks. Manual takeover holds the UI lock; inspect in-flight jobs after release. Optional media, ASR, image generation, embedding, heartbeats and notifications require configuration. Backups and restore drills must preserve live state. Report missing capabilities rather than claiming a zero-configuration deployment.

## Copyable AI deployment prompt

```text
Deploy this Ruanruan repository on the current Linux host. Complete the authorized automation.
Read AGENTS.md, desktop/AGENTS.md, docs/DEPLOYMENT.md, desktop/README.md, package.json, Compose, installers and units. Inspect the real user, paths, dependencies, resources, interfaces and routing. Adapt template values narrowly; preserve unrelated projects.
Deploy the official personal-WeChat character channel: read-only local DB intake and reviewed GUI sending. Install dependencies, build, run offline fixture tests, create disabled configuration and GENERATE.md/REVIEW.md links, and configure generation/review/revision from character-models.example.json. Keep credentials in private local 0600 files, never in output or Git. Report unavailable media, ASR, notifications and other optional services.
Adapt this project's direct-network rules while preserving other containers and the model proxy. Install the manual-control socket/hook before starting only the login desktop. Provide a localhost SSH tunnel or trusted HTTPS endpoint.
A human must scan the official client QR code, approve phone login, and verify both account identities plus the owner's unique contact label. Reuse verified local information, consolidate missing inputs, and continue independent work. After login run the reader installer and --prepare with automatic intake/sending disabled, then activate database transport after verification. Route synchronization enables multiple contacts/groups; owner binding is not an allowlist. If I require owner-only responses, implement and offline-test explicit filtering rather than claiming multiUser=false provides isolation.
Do not run live model samples, send synthetic messages, click verification/appeal controls or blindly resend uncertain deliveries. I will perform live chat acceptance. Continue authorized reversible setup without requesting approval for each command.
Deliver changed files, local config/data paths, offline results, start/stop/status/log commands, the browser entry, takeover/release instructions, optional capability status and exact remaining human steps. Distinguish offline validation, running services and confirmed delivery. Do not promise zero-configuration setup or complete live acceptance.
```
