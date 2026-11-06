# Ruanruan deployment

[简体中文](DEPLOYMENT.md) | **English**

This repository deploys a character on the official Linux personal-WeChat client: read-only local database intake, character generation and independent review, then visible GUI sending. It supports private/group chats, memory and relationships, media, optional voice transcription and a simulated-life heartbeat. See [architecture](ARCHITECTURE.en.md) for model calls.

Follow this order: **host checks → build/offline validation → disabled configuration → desktop login → human scan and identity checks → preparation → activation**. Adapt host paths, interfaces, addresses and resource limits. Credentials and private media are supplied locally; this is not a zero-configuration package.

## 1. Dependencies and host checks

Read [root AGENTS.md](../AGENTS.md), [desktop AGENTS.md](../desktop/AGENTS.md) and the [desktop operations reference](../desktop/README.md). These operational references and persona prompts are currently in Chinese. Required components include Linux, Node.js **≥ 22.13.0**, npm, Git, Python **≥ 3.11**, Docker Engine/Compose, systemd system/user services, `flock`, `ip`, `iptables`, SSH and a compatible Codex CLI/app-server. API-backed models still use local app-server orchestration. Containers/native dependencies mainly target x86_64; check images, SQLCipher, sqlite-vec, OCR and audio dependencies on other architectures.

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

The deployment user needs Docker access and working user systemd. Configure `loginctl enable-linger` for that actual user when services must survive SSH logout; do not install user units into root's home. Services and workers must find the same Node version, including with nvm. Budget for GUI, reader, OCR, chat and background memory together; unit limits are not total host peak-memory guarantees. Preserve unrelated containers, networks and model proxies.

## 2. Checkout, build and offline validation

Use the repository owner's SSH or local Git credentials. Do not embed tokens in clone URLs.

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

`npm ci` runs postinstall to generate `dist/`; `build:desktop` generates `dist-desktop/`. Retain the output selected by the runtime unit's `WCB_BUILD_DIR`. Do not copy another machine's runtime/account database into source.

The following checks use mocks and temporary files, without logging into WeChat, calling real models or sending messages:

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

Remove only the temporary `RR_CHECK_DATA` created for these checks afterward. Inspect other scripts before running them; live sampling and sending scripts are not offline tests.

## 3. Local configuration and persona prompts

The following commands are for a **new data directory**. Back up an existing installation and merge individual changes while retaining identity, sessions, cursors and holds.

```bash
install -d -m 700 "$RR_DATA" "$RR_DATA/app" "$RR_DATA/app/logs" \
  "$RR_DATA/app/providers" "$RR_DATA/bridge" "$RR_DATA/config" "$RR_DATA/exchange"
cp desktop/bridge.example.json "$RR_DATA/bridge.json"
cp character-models.example.json "$RR_DATA/app/providers/character-models.json"
ln -s "$RR_ROOT/personas/ruanruan/GENERATE.md" "$RR_DATA/app/GENERATE.md"
ln -s "$RR_ROOT/personas/ruanruan/REVIEW.md" "$RR_DATA/app/REVIEW.md"
chmod 600 "$RR_DATA/bridge.json" "$RR_DATA/app/providers/character-models.json"
```

Set `exchangeDirectory` and `queueDirectory` in `bridge.json` to actual absolute paths. Keep `enabled=false` and contacts empty initially. Database preparation synchronizes real contact/group routes and sets `multiUser=true`. Administrator binding verifies identity; **it is not an intake allowlist**. Owner-only replies require explicit, tested filtering rather than relying on `multiUser=false`.

`GENERATE.md` defines personality and expression; `REVIEW.md` defines review constraints. Adapt them to the character without putting passwords, API keys or server permissions in prompts, and without clearing conversations merely to change a prompt.

[Role configuration](../character-models.example.json) separates generation, review and text revision:

| Role | Model | Reasoning effort | Service tier |
| --- | --- | --- | --- |
| Generation | `gpt-6-sol` | `low` | `default` |
| Review | `gpt-6-sol` | `low` | `default` |
| Revision | `gpt-6.1-sol` | `medium` | `default` |

**Model integration and selection:** The project supports Codex CLI (`app-server`) and OpenAI-format model APIs. The main conversation path uses Responses API: providers must support `/responses`, streaming and tool calling. Chat-Completions-only services need a gateway with Responses conversion. API mode still uses local Codex CLI orchestration; it does not imply local model inference.

For Chinese character dialogue, try **DeepSeek V4.1 Flash** or **Gemini 3.8 Flash** first. This reflects the author's preference for their Chinese voice and group-chat responses in this project. See the [overview model section](../README.en.md#model-integration-and-recommendations) for model IDs, compatibility boundaries and official references. GPT IDs in the examples are reference settings. When switching providers, check generation, review, revision and background-task model IDs rather than changing only `baseUrl`.

Your provider must support the configured models; report unavailable models. Use a logged-in Codex backend or an API provider. Save this API example to `app/providers/llm.json`:

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

Store the key only in local `app/providers/openai.json`, as `{"apiKey":"FILL_LOCALLY"}`. Add `proxyUrl` if required and set file permissions to `0600`. `llm.json` does not accept an inline key. For Codex use `{"active":"codex","providers":{}}` and have a human log in as the runtime user.

```bash
node scripts/llm-backend.mjs --desktop status
```

This reports configuration, not model availability. Backend scripts default to `$HOME/.wechat-codex-desktop/app`; `WCB_DATA_DIR` selects another instance. `use <configured-provider>` changes only that instance; `scope: character` also synchronizes its heartbeat backend. Check permissions/quota for role models, ASR, images, embeddings and background models separately; do not silently switch providers or billing channels.

## 4. Desktop, direct networking and manual takeover

Adapt these templates before installing:

- `desktop/compose.yaml`: mounts, UID/GID, listeners, subnet and bridge name.
- `desktop/direct-network.sh`: physical egress, routing table/priorities, remote-management return routes and iptables backend. Check subnet conflicts.
- Desktop/systemd units: project, data and Node paths; new-session working directory; the Windows launcher's SSH target.
- Python units: `WCB_DESKTOP_DATA`. Prefer the per-user default `$HOME/.wechat-codex-desktop` initially, and keep every component consistent.

WeChat uses physical-interface direct egress, separately from the model proxy. Change only this project's networking. **Start direct-network rules before the GUI service, rather than bypassing them with raw Compose startup.**

Create private `desktop.env` in the data root with mode `0600`, filling the password locally:

```dotenv
PUID=<DEPLOY_USER_UID>
PGID=<DEPLOY_USER_GID>
TZ=Asia/Shanghai
CUSTOM_USER=<LOCAL_DESKTOP_LOGIN>
PASSWORD=<LOCAL_STRONG_PASSWORD>
```

Prefer publishing only `127.0.0.1:3290:3000`. Retain the pinned image digest, `start-wechat.sh` and manual-control hook mounts. Resolve hook/Selkies compatibility errors rather than skipping takeover checks.

After adaptation, install the takeover socket before starting the login desktop:

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

Automatic replies remain disabled. Socket permissions must match the deployment and container desktop users.

## 5. Human login and first preparation

On your own computer, create a tunnel using the actual SSH user and host:

```bash
ssh -N -T -L 127.0.0.1:13390:127.0.0.1:3290 \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
  DEPLOY_USER@SERVER
```

Keep it running and open **http://127.0.0.1:13390/** with the desktop password. This forwards HTTP; changing the URL to HTTPS does not add TLS. Non-localhost access requires trusted HTTPS and WebSocket forwarding. Adapt `desktop/windows/` for a Windows launcher.

A human scans the official client's QR code, confirms on the phone and verifies the character account, administrator account, unique owner label and current conversation. Leave account checks, unusual-login prompts and restrictions to the human; automation does not click verification, relogin or appeals. Set the verified values:

```bash
export RR_ACCOUNT_WECHAT_ID='<VERIFIED_CHARACTER_WECHAT_ID>'
export RR_OWNER_WECHAT_ID='<VERIFIED_OWNER_WECHAT_ID>'
export RR_OWNER_UI_LABEL='<VERIFIED_UNIQUE_REMARK>'
```

Populate the initial owner route while `bridge.json` is disabled:

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

Keep the client in the verified conversation and close the interactive browser to release the UI lock. Then build the read-only reader and prepare:

```bash
python3 desktop/install_database_transport.py \
  --account-wechat-id "$RR_ACCOUNT_WECHAT_ID" \
  --owner-wechat-id "$RR_OWNER_WECHAT_ID"
python3 desktop/database_operator.py --check
python3 desktop/database_operator.py --prepare
```

The installer must see exactly one logged-in account. It fetches a pinned upstream revision and includes `rpc.py` and `live_database.py` in the image build. See [UPSTREAM.txt](../desktop/db-worker/UPSTREAM.txt) for revision/license information. This installer is not intended to run before login.

`--prepare` keeps automatic intake/sending disabled, synchronizes real routes, checks the owner conversation and saves binding/readiness/watermarks. It does not import incoming tasks, call dialogue models or send messages. Deferred group background is imported after activation; newer messages remain available for normal intake. Preparation accesses the real database and UI, so it is not an offline test. The WeChat source directory remains read-only.

## 6. Activation and acceptance

Install the adapted user units:

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

**Activation enables replies and clears the application hold.** It is not a routine restart command. Once services run, a human performs normal-conversation acceptance:

```bash
systemctl --user status wechat-desktop-runtime.service wechat-desktop-bridge.service wechat-desktop-database.service --no-pager
python3 desktop/wechat_gui.py bridge_status
journalctl --user -u wechat-desktop-database.service -n 40 --no-pager
```

Check server-confirmed receipts rather than clicks. To stop automatic intake/sending, run `systemctl --user stop wechat-desktop-database.service wechat-desktop-bridge.service`. Retain the runtime, client and data; inspect holds and uncertain receipts before starting those two services again.

Interactive browser access holds the shared UI lock until the last connection closes. Minimizing the page is not disconnecting, and `#shared` does not guarantee view-only access. Prefer waiting for the current reply before takeover, and inspect in-flight tasks after release. After inspecting the actual situation, `python3 desktop/manual_control.py release` can release a stale manual hold. It does not clear account-safety holds or guarantee replay of an in-flight reply.

## 7. Optional capabilities and data maintenance

| Capability | Configuration and fallback |
| --- | --- |
| Private media | Not supplied by the repository. Set `WCB_MEDIA_ROOT` to a real server directory with the expected catalog JSON and referenced images/videos/reactions, not a Windows mapped drive. Bridge and systemd workers need the variable; exporting it only in SSH is insufficient. Missing media yields empty local search while text chat remains available. `scripts/refresh-local-media.mjs --root` updates an existing catalog. |
| Voice | The reader image includes ffmpeg/pilk; ASR additionally needs `app/providers/asr.json` and provider configuration. Missing service or failed decoding stays unknown. Transcripts may be wrong; a human accepts real voice behavior. |
| Life heartbeat | `systemd/ruanruan-heartbeat.service` uses the character app, desktop runtime and same life ledger. API mode needs `providers/heartbeat.json`, with connection/credentials from `providers/openai-embeddings.json`. Local checks run about every seven minutes; model attempts are at least 45 minutes apart, capped at 24 per day. |
| Images and vector recall | Require their provider configuration/credentials and existing reference assets. Report unavailable capabilities. Background calls have their own usage. |
| Visual recovery / code repair | Controlled by `modelRecovery.enabled`, `autoRepair.enabled` in `database.json` and the repair service. Verify basic transport first, then configure budgets when enabling. |
| External notifications | An optional adapter handles account/runtime alerts with an independently configured destination and credentials. Without it, local alerts, holds and logs remain, and external notification is unavailable. Confirm delivery separately. |
| Backups | `scripts/backup-character-state.py` defaults to the character data root, including `app/character-life`. Adapt service/timer paths and private destination. Explicitly include an existing external life-ledger root instead of creating a replacement ledger. SQLite uses its backup API; structured credentials are excluded by default and configured separately on restore. Prune only tool-owned snapshots. |

Replace destinations and snapshot paths before running a first backup and restore drill:

```bash
python3 scripts/backup-character-state.py backup --desktop "$RR_DATA" --destination '<PRIVATE_BACKUP_DIRECTORY>'
python3 scripts/backup-character-state.py verify '<SNAPSHOT_DIRECTORY>'
python3 scripts/backup-character-state.py restore-drill '<SNAPSHOT_DIRECTORY>' --target '<NEW_DRILL_DIRECTORY>'
```

The drill target must be a new, nonexistent directory outside online operation. After verification, install the adapted backup timer. Export local usage with `scripts/export-api-usage.py`; export heartbeats with `scripts/export-heartbeat.py --once --data <APP_DIRECTORY> --output <OUTPUT_FILE>` to an existing parent directory. These read local records without model requests.

Before updates, back up, build and validate offline, then wait for in-flight tasks and restart affected services only. Keep model credentials, desktop passwords, login data, real conversations, screenshots/audio, media, logs and backups in private local directories, including when the Git repository is private.

## Copyable AI deployment prompt

```text
Deploy this Ruanruan repository on the current Linux host. Complete the authorized automation.
Read AGENTS.md, desktop/AGENTS.md, docs/DEPLOYMENT.en.md, desktop/README.md, package.json, Compose, installers and units. Inspect the real user, paths, dependencies, resources, interfaces and routing. Adapt template values narrowly; preserve unrelated projects.
Deploy the official personal-WeChat character channel: read-only local DB intake and reviewed GUI sending. Install dependencies, build, run offline fixture tests, create disabled configuration and GENERATE.md/REVIEW.md links, and configure generation/review/revision from character-models.example.json. Keep credentials in private local 0600 files, never in output or Git. Report unavailable media, ASR, notifications and other optional services.
Adapt this project's direct-network rules while preserving other containers and the model proxy. Install the manual-control socket/hook before starting only the login desktop. Provide a localhost SSH tunnel or trusted HTTPS endpoint.
A human must scan the official client QR code, approve phone login, and verify both account identities plus the owner's unique contact label. Reuse verified local information, consolidate missing inputs, and continue independent work. After login run the reader installer and --prepare with automatic intake/sending disabled, then activate database transport after verification. Route synchronization enables multiple contacts/groups; owner binding is not an allowlist. If I require owner-only responses, implement and offline-test explicit filtering rather than claiming multiUser=false provides isolation.
Do not run live model samples, send synthetic messages, click verification/appeal controls or blindly resend uncertain deliveries. I will perform live chat acceptance. Continue authorized reversible setup without requesting approval for each command.
Deliver changed files, local config/data paths, offline results, start/stop/status/log commands, the browser entry, takeover/release instructions, optional capability status and exact remaining human steps. Distinguish offline validation, running services and confirmed delivery. Do not promise zero-configuration setup or complete live acceptance.
```

