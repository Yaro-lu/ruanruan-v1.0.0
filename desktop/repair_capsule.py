"""Host-owned native Codex filesystem profile, separate from inference authentication."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import tomllib
import uuid


def _toml(value):
    if isinstance(value, str): return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool): return 'true' if value else 'false'
    if isinstance(value, (int, float)): return str(value)
    if isinstance(value, list): return '[' + ', '.join(_toml(item) for item in value) + ']'
    if isinstance(value, dict): return '{ ' + ', '.join(_toml(key) + ' = ' + _toml(item) for key, item in value.items()) + ' }'
    raise ValueError('Unsupported isolated Codex configuration value')


def capsule_config(workspace, environment, original, auth_home):
    root = Path(workspace['path']).resolve()
    modules = (root / 'node_modules').resolve()
    shell_home = root / '.repair-validation/home'
    scratch = root / '.repair-validation/tmp'
    shell = {key: environment[key] for key in ('WCB_DATA_DIR', 'WCB_DESKTOP_DATA', 'WCB_DESKTOP_CONFIG',
        'WCB_DESKTOP_CONTAINER', 'WCB_CODEX_EPHEMERAL', 'NODE_NO_WARNINGS') if key in environment}
    shell.update(PATH='/usr/local/bin:/usr/bin:/bin', HOME=str(shell_home), TMPDIR=str(scratch), LANG='C.UTF-8',
                 PYTHONDONTWRITEBYTECODE='1')
    value = {'default_permissions': 'repair', 'approval_policy': 'never', 'allow_login_shell': False,
        'cli_auth_credentials_store': 'file', 'web_search': 'disabled',
        'project_doc_max_bytes': 0,
        'features': {'apps': False, 'plugins': False, 'fast_mode': False,
            'hooks': False, 'plugin_hooks': False, 'skip_host_skill_discovery': True},
        'mcp_servers': {name: {'enabled': False} for name in original.get('mcp_servers', {})},
        'shell_environment_policy': {'inherit': 'none', 'ignore_default_excludes': False, 'set': shell},
        'permissions': {'repair': {'filesystem': {':minimal': 'read', str(root): 'write',
            str(modules): 'read', str(auth_home): 'deny', '/proc': 'deny'},
            'network': {'enabled': False}}}}
    # Only the active model provider crosses the boundary. No user hooks, MCPs,
    # skills, global instructions, project rules, or other service settings.
    provider = original.get('model_provider')
    if provider:
        value['model_provider'] = provider
        if provider in original.get('model_providers', {}):
            value['model_providers'] = {provider: original['model_providers'][provider]}
    if isinstance(original.get('chatgpt_base_url'), str): value['chatgpt_base_url'] = original['chatgpt_base_url']
    return value


@contextmanager
def isolated_model(workspace, directory, command, environment):
    original_home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    original_config = original_home / 'config.toml'
    original = tomllib.loads(original_config.read_text()) if original_config.is_file() else {}
    config = capsule_config(workspace, environment, original, original_home)
    shell = config['shell_environment_policy']['set']
    for name in ('HOME', 'TMPDIR'): Path(shell[name]).mkdir(parents=True, exist_ok=True, mode=0o700)
    env = {**environment, 'HOME': shell['HOME'], 'CODEX_HOME': str(original_home), 'TMPDIR': shell['TMPDIR']}
    profile = 'wechat-repair-' + uuid.uuid4().hex
    path = original_home / (profile + '.config.toml')
    # Provider headers may contain credentials; keep them out of argv/logs.
    with path.open('x') as stream:
        path.chmod(0o600)
        stream.write('\n'.join(key + ' = ' + _toml(value) for key, value in config.items()) + '\n')
    args = [command[0], '-p', profile, *command[1:]]
    # The host overlays its repair profile on trusted user configuration and
    # exec ignores rules. Do not set --ignore-user-config: Codex 0.164 also skips
    # the selected -p profile with that flag. Keep the real auth store ONLY in the trusted inference process
    # so normal OAuth refresh stays consistent with the user's existing login.
    # Tool children get a clean environment, cannot read that store or other
    # production paths, and run in Codex's own single bwrap-backed sandbox.
    # Do not wrap that sandbox again: this host rejects nested user namespaces.
    try:
        yield args, env
    finally:
        path.unlink(missing_ok=True)
