"""Bounded, exceptional visual planning; this module never executes GUI actions."""
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from wechat_gui import DATA, PROJECT, BRIDGE_CONFIG, bridge_call


STAGES = {'conversation', 'mention', 'inspect', 'recover', 'receipt'}
REGION_IDS = {'conversation_candidates', 'mention_candidates', 'send_button'}


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def rectangle(value):
    if not isinstance(value, dict):return None
    result = {key: value.get(key, value.get(legacy)) for key, legacy in
              (('x', 'X'), ('y', 'Y'), ('width', 'WIDTH'), ('height', 'HEIGHT'))}
    if not all(number(item) for item in result.values()):return None
    if result['x'] < 0 or result['y'] < 0 or result['width'] <= 0 or result['height'] <= 0:return None
    return result


def contains(region, x, y):
    return region['x'] <= x < region['x'] + region['width'] and region['y'] <= y < region['y'] + region['height']


def observed_label_matches(observed, names, group=False, mention=False):
    def label(text):
        text=''.join(text.split())
        return re.sub(r'[（(]\d+[）)]$', '', text) if group else text
    value=label(observed)
    if value in [label(name) for name in names]:return True
    prefix=re.fullmatch(r'(.+?)(?:\.{2,}|…+)',value) if mention else None
    return bool(prefix and any(label(name).startswith(prefix.group(1)) for name in names))


def valid_result(value, stage, geometry, regions, target):
    """Recheck the CLI boundary locally, including exact action semantics."""
    if not isinstance(value, dict) or type(value.get('ok')) is not bool:return False
    if not number(value.get('elapsedMs')) or value['elapsedMs'] < 0:return False
    if 'usageId' in value and (not isinstance(value['usageId'],str) or not re.fullmatch(r'[a-f0-9-]{36}',value['usageId'])):return False
    if 'usage' in value:
        usage=value['usage'];fields={'inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'}
        if not isinstance(usage,dict) or set(usage)-fields or any(not number(v) or v<0 for v in usage.values()):return False
    if not value['ok']:
        error = value.get('error')
        return not(set(value)-{'ok', 'error', 'elapsedMs','usage','usageId'}) and isinstance(error, dict) \
            and set(error) == {'code', 'message'} \
            and isinstance(error['code'], str) and 0 < len(error['code']) <= 100 \
            and isinstance(error['message'], str) and 0 < len(error['message']) <= 2000
    required = {'ok', 'decision', 'screen', 'targetMatches', 'point', 'observedText', 'reason', 'elapsedMs'}
    if not required.issubset(value) or set(value) - required - {'model', 'provider','usage','usageId'}:return False
    if any(not isinstance(value[key], str) or not value[key] or len(value[key]) > 200 for key in ('model', 'provider') if key in value):return False
    if value['decision'] not in ('retry', 'locate', 'stop') or value['screen'] not in ('chat', 'security', 'logged_out', 'unknown'):return False
    if type(value['targetMatches']) is not bool:return False
    if not isinstance(value['observedText'], str) or len(value['observedText']) > 4000:return False
    if not isinstance(value['reason'], str) or not value['reason'].strip() or len(value['reason']) > 2000:return False
    point = value['point']
    if value['screen'] != 'chat' and (value['decision'] != 'stop' or point is not None):return False
    if value['decision'] != 'stop':
        if not value['observedText'].strip():return False
        if stage not in ('recover', 'receipt'):
            identity = target.get('mention', {}) if stage == 'mention' else target
            names = [identity.get('name', identity.get('label', '')), *identity.get('aliases', [])]
            if not value['targetMatches'] or not observed_label_matches(value['observedText'],names,
                    group=stage!='mention' and target.get('kind')=='group',mention=stage=='mention'):return False
    if point is None:return value['decision'] != 'locate'
    if stage in ('recover', 'receipt') or value['decision'] != 'locate' or not value['targetMatches']:return False
    if not isinstance(point, dict) or set(point) != {'regionId', 'x', 'y'}:return False
    if not isinstance(point['regionId'], str) or not number(point['x']) or not number(point['y']):return False
    expected = {'conversation':'conversation_candidates', 'mention':'mention_candidates', 'inspect':'send_button'}.get(stage)
    if point['regionId'] != expected:return False
    region = next((item for item in regions if item['id'] == point['regionId']), None)
    return bool(region and contains(region, point['x'], point['y']) and contains(geometry, point['x'], point['y']))


class ModelRecovery:
    def __init__(self, max_calls=4):
        self.max_calls = max(0, min(4, int(max_calls)))
        self.calls = 0
        self.last_error = None

    @staticmethod
    def active_delivery(delivery):
        current = bridge_call('active-delivery', {'leaseId': delivery['leaseId']}).get('delivery')
        if not isinstance(current, dict) or current.get('status') != 'ready' \
                or current.get('id') != delivery.get('id') or current.get('leaseId') != delivery['leaseId']:
            raise RuntimeError('Visual recovery requires the same active delivery lease')
        return current

    def analyze(self, stage, screenshot, failure, settings, geometry, delivery=None,
                allowed_regions=None, attempted=False):
        self.last_error = None
        if self.calls >= self.max_calls:
            self.last_error = 'call_budget_exhausted'
            return None
        if attempted:stage = 'receipt'
        bounds = rectangle(geometry)
        if stage not in STAGES or not bounds:
            self.last_error = 'invalid_request'
            return None
        lease = isinstance(delivery, dict) and bool(delivery.get('leaseId'))
        if not lease and stage in ('conversation', 'mention'):
            self.last_error = 'active_lease_required'
            return None
        if lease:
            try:
                bridge_call('extend-delivery', {'leaseId': delivery['leaseId']})
                active = self.active_delivery(delivery)
                # Preserve the authorized extended deadline for the caller's
                # later database acknowledgement wait, never alter its reply.
                if number(active.get('leaseUntil')):delivery['leaseUntil'] = active['leaseUntil']
            except Exception:
                self.last_error = 'lease_unavailable'
                return None
        regions = []
        if lease and stage not in ('recover', 'receipt'):
            for source in allowed_regions or []:
                region = rectangle(source)
                if not region or source.get('id') not in REGION_IDS \
                        or any(item['id'] == source['id'] for item in regions) \
                        or not contains(bounds, region['x'], region['y']) \
                        or region['x'] + region['width'] > bounds['x'] + bounds['width'] \
                        or region['y'] + region['height'] > bounds['y'] + bounds['height']:
                    self.last_error = 'invalid_regions'
                    return None
                if stage == 'inspect' and source['id'] != 'send_button':continue
                regions.append({'id': source['id'], **region})
        target = {'label': (delivery or {}).get('uiLabel') or settings.get('uiLabel'),
                  'kind': settings.get('kind', 'private')}
        if not isinstance(target['label'], str) or not target['label'].strip():
            self.last_error = 'missing_target'
            return None
        if target['kind'] not in ('private', 'group'):
            self.last_error = 'invalid_target'
            return None
        mention = (delivery or {}).get('mention')
        if mention:
            if not isinstance(mention, dict) or not all(isinstance(mention.get(key), str) and mention[key] for key in ('username', 'name')):
                self.last_error = 'invalid_target'
                return None
            member = next((item for item in settings.get('members', []) if item.get('username') == mention['username']), {})
            aliases = mention.get('aliases') or member.get('mentionNames') or [mention['name']]
            if not isinstance(aliases, list) or not all(isinstance(alias, str) for alias in aliases):
                self.last_error = 'invalid_target'
                return None
            target['mention'] = {'username': mention['username'], 'name': mention['name'],
                                 'aliases': list(dict.fromkeys([mention['name'], *aliases]))}
        env = os.environ.copy()
        env.update(WCB_DATA_DIR=str(DATA / 'app'), WCB_CODEX_RUNTIME_SOCKET=str(DATA / 'app/codex-runtime.sock'),
                   WCB_DESKTOP_CONFIG=str(BRIDGE_CONFIG), WCB_CODEX_EPHEMERAL='1', NODE_NO_WARNINGS='1')
        try:
            with tempfile.TemporaryDirectory(prefix='ruanruan-visual-recovery-') as folder:
                os.chmod(folder, 0o700)
                snapshot = Path(folder) / 'screen.png'
                shutil.copyfile(screenshot, snapshot)
                snapshot.chmod(0o600)
                request = {'stage': stage, 'screenshotPath': str(snapshot), 'failure': str(failure)[:2000],
                           'target': target, 'geometry': bounds, 'allowedRegions': regions}
                if delivery and delivery.get('id'):request['deliveryId']=delivery['id']
                if delivery and delivery.get('kind') in ('text', 'image', 'video'):
                    request['delivery'] = {'kind': delivery['kind'], 'sendAttempted': bool(attempted)}
                    if isinstance(delivery.get('text'), str):request['delivery']['text'] = delivery['text']
                self.calls += 1
                result = subprocess.run(['node', str(PROJECT / 'dist-desktop/src/desktop/recovery-cli.js')],
                    input=json.dumps(request, ensure_ascii=False).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    timeout=125, env=env, check=False)
                if result.returncode:
                    self.last_error = 'planner_process_failed'
                    return None
                value = json.loads(result.stdout)
                if not valid_result(value, stage, bounds, regions, target):
                    self.last_error = 'invalid_planner_result'
                    return None
                # Security observations still reach the caller if a slow model
                # consumed the lease; locating UI elements never bypasses it.
                if value.get('point') is not None:
                    try:self.active_delivery(delivery)
                    except Exception:
                        self.last_error = 'lease_expired_after_planning'
                        return None
                return value
        except subprocess.TimeoutExpired:
            self.last_error = 'planner_timeout'
        except (OSError, ValueError, TypeError):
            self.last_error = 'planner_unavailable'
        return None
