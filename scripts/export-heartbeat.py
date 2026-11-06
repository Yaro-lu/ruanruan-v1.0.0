#!/usr/bin/env python3
"""Read existing heartbeat data and maintain one human-readable Markdown file."""
import argparse
from contextlib import closing
import datetime as dt
import hashlib
import html
import json
import math
import os
from pathlib import Path
import sqlite3
import tempfile
import time

DATA = Path(os.environ.get('WCB_DATA_DIR', Path.home()/'.wechat-codex-desktop/app')).expanduser().resolve()
OUTPUT = Path('/mnt/D-2TB/.codex/阮阮素材/阮阮心跳记录.md')
ZONE = dt.timezone(dt.timedelta(hours=8))
STATUS = {'started': '进行中', 'committed': '已采纳', 'discarded': '未采纳'}
PHASE = {'asleep': '睡眠', 'morning': '早晨', 'work': '工作', 'lunch': '午间',
         'leisure': '休闲', 'dinner': '晚饭', 'evening': '晚间',
         'awake': '当前有活动或互动', 'unconfirmed': '按当天安排，具体活动未单独确认'}
PLACE = {'home': '住处', 'shop': '门店', 'outside': '外出', 'unspecified': '未指定'}
ACTION = {'rest': '休息', 'music': '听歌', 'meal': '吃饭', 'shop_observation': '门店观察', 'shopping': '挑选购买',
          'outing': '外出', 'walk': '散步', 'budget': '整理开店小账', 'shop_moment': '店内小事', 'shop_break': '上班空当',
          'home_moment': '合租日常', 'curiosity': '琢磨感兴趣的问题', 'commute_moment': '路上见闻'}
DECISION = {'started': '开始小行动', 'continued': '继续原安排', 'deferred': '暂时放下'}
PARAMETERS = [('心情', 'mood.value'), ('体力', 'energy'), ('余额（元）', 'finance.cash'),
              ('开店储蓄（元）', 'finance.savings'), ('可支配（元）', 'finance.spendable'),
              ('预留生活费（元）', 'finance.reserved'), ('储蓄目标（元）', 'finance.savingsGoal'),
              ('管理员好感度', 'administratorAffection')]


def stamp(value):
    return dt.datetime.fromtimestamp(value / 1000, ZONE).strftime('%Y-%m-%d %H:%M:%S') if value else '暂无'


def text(value):
    return str(value or '').replace('\r', ' ').replace('\n', ' ').strip()


def read_snapshot():
    path = DATA / 'character-life/life.sqlite3'
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        state = {row['key']: json.loads(row['value']) for row in db.execute('SELECT key,value FROM state')}
        attempts = [dict(row) for row in db.execute('SELECT id,day,at,status,usage FROM attempts ORDER BY at DESC')]
        events = [dict(row) for row in db.execute('SELECT id,at,meaningful,value FROM events ORDER BY at DESC')]
        db.rollback()
    try:
        config = json.loads((DATA / 'providers/heartbeat.json').read_text())
    except FileNotFoundError:
        config = {'backend': 'codex', 'codexModel': 'gpt-6-luna'}
    heartbeats = []
    log = DATA / 'character-life/heartbeat-log.sqlite3'
    if log.exists():
        with closing(sqlite3.connect(log.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
            heartbeats = [json.loads(row[0]) for row in db.execute('SELECT value FROM heartbeats ORDER BY at DESC,rowid DESC')]
    ledger = []
    metrics_path = DATA / 'character-life/metrics.sqlite3'
    if metrics_path.exists():
        with closing(sqlite3.connect(metrics_path.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            ledger = [dict(row) for row in db.execute('SELECT at,category,amount,reason FROM ledger ORDER BY at')]
    return {'state': state, 'attempts': attempts, 'events': events, 'runtime': config,
            'heartbeats': heartbeats, 'ledger': ledger}


def read_results(ids):
    results = {}
    for path in (DATA / 'jobs').glob('*/job.json'):
        job = json.loads(path.read_text())
        if job.get('kind') != 'life' or job.get('life', {}).get('id') not in ids:
            continue
        batch_id = job['life']['id']
        status_path = path.parent / 'status.json'
        if not status_path.exists():
            continue
        result = json.loads(status_path.read_text()).get('result') or {}
        raw = result.get('replyText', '').strip()
        if raw.startswith('```'):
            raw = '\n'.join(raw.splitlines()[1:-1])
        try:
            delta = json.loads(raw)
            if not isinstance(delta, dict):
                delta = {}
        except ValueError:
            delta = {}
        results[batch_id] = {'delta': delta, 'model': (job.get('options') or {}).get('model'),
                             'reasoningEffort': (job.get('options') or {}).get('reasoningEffort'),
                             'metrics': job.get('life', {}).get('metrics')}
    return results


def cell(parts):
    return '；'.join(html.escape(text(part), quote=False).replace('|', '&#124;') for part in parts if part is not None and text(part))


def number(data, path):
    for key in path.split('.'):
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data if type(data) in (int, float) and math.isfinite(data) else None


def short_reason(value):
    value = text(value).split('；', 1)[0].rstrip('。')
    return value if len(value) <= 20 else value[:19] + '…'


def parameter_reason(path, after, baseline, change, ledger):
    if change is None:
        return '无对比记录'
    if change == 0:
        return '无变化'
    start, end = number(baseline, 'at'), number(after, 'at')
    rows = [row for row in ledger if start is not None and end is not None and start < row['at'] <= end]
    if path in ('finance.cash', 'finance.savings'):
        cash = path == 'finance.cash'
        relevant = [row for row in rows if row['amount'] and (cash or row['category'] == 'saving')]
        amount = sum(row['amount'] * (1 if cash else -1) for row in relevant)
        if relevant and abs(amount - change) < .011:
            names = {'food': '餐饮结算', 'transport': '通勤支出', 'salary': '工资到账',
                     'rent': '房租结算', 'utilities': '水电结算', 'saving': '转入开店储蓄'}
            reasons = list(dict.fromkeys(names.get(row['category'], short_reason(row['reason'])) for row in relevant))
            return short_reason('、'.join(reasons))
    if path == 'finance.spendable':
        values = [number(data, key) for data in (baseline, after)
                  for key in ('finance.cash', 'finance.reserved', 'finance.spendable')]
        if all(value is not None for value in values):
            old_cash, old_reserved, old_value, cash, reserved, value = values
            if abs(max(0, old_cash - old_reserved) - old_value) < .011 and abs(max(0, cash - reserved) - value) < .011:
                return '、'.join(label for label, changed in [('余额变化', cash != old_cash),
                                                            ('生活费预留调整', reserved != old_reserved)] if changed)
    if path == 'finance.reserved':
        return '生活费预留重算'
    if path == 'finance.savingsGoal':
        return '储蓄目标调整'
    # A mood reason describes the current background and can survive many
    # heartbeats. It isn't evidence of this interval's change. Energy and
    # affection likewise lack a saved breakdown; never invent sleep or chats.
    return '未单独记录'


def parameter_rows(entry=None, historical=None, ledger=()):
    entry = entry or {}
    after = entry.get('after') or historical or {}
    baseline = (entry.get('previous') or {}).get('after') or entry.get('before') or {}
    values, changes, reasons = [], [], []
    for _, path in PARAMETERS:
        value, prior = number(after, path), number(baseline, path)
        if value is None:
            values.append('未记录'); changes.append(''); reasons.append('')
        else:
            change = round(value - prior, 2) if prior is not None else None
            values.append(f'{value:,.2f}')
            changes.append(f'{change if change else 0:+.2f}' if change is not None else '未记录')
            reasons.append(parameter_reason(path, after, baseline, change, ledger))
    return [('数值', values), ('增减', changes), ('原因', reasons)]


def parameter_note(entry=None, historical=None):
    entry = entry or {}
    after = entry.get('after') or historical or {}
    parts = []
    if not after:
        parts.append('未保存参数快照')
    elif not entry:
        parts.append('历史模型输入快照')
    mood = after.get('mood') or {}
    if mood.get('kind'):
        parts.append(f'心情状态：{mood["kind"]}')
    if mood.get('reason'):
        parts.append(f'心情背景：{short_reason(mood["reason"])}')
    if entry.get('finishedAt'):
        parts.append(f'结算时间：{stamp(entry["finishedAt"])[11:]}')
    return cell(parts)


def attempt_cell(attempt, result):
    delta = result.get('delta') or {}
    accepted = attempt['status'] == 'committed'
    parts = [f'模型心跳 · {STATUS.get(attempt["status"], attempt["status"])}']
    if 'action' in delta:
        action = ACTION.get(delta.get('action'), delta.get('action')) or '继续原安排'
        parts.append(f'行动提议：{action}；{text(delta.get("reason"))}')
        detail = delta.get('detail') or {}
        if detail.get('activity'):
            parts.append(f'拟进行：{detail["activity"]}')
    activity = delta.get('activity') or {}
    if isinstance(activity, dict) and activity.get('text'):
        parts.append(f'活动提议：{activity["text"]}')
    if not accepted and delta:
        parts.append('以上为尚未生效的提议。')
    elif accepted and delta.get('action'):
        parts.append('行动完成后另记事件。')
    if delta.get('event') is None and 'event' in delta:
        parts.append('本次没有新增事件。')
    if not delta:
        parts.append('当前留存数据中没有可读取的模型输出。')
    if result.get('model'):
        parts.append(f'模型：{result["model"]} / {result.get("reasoningEffort") or "未记录"}')
    if delta.get('nextInMinutes'):
        parts.append(f'下次检查建议：{delta["nextInMinutes"]} 分钟后')
    usage = json.loads(attempt['usage']) if attempt.get('usage') else {}
    if usage:
        def tokens(key):
            value = usage.get(key)
            return f'{value:,}' if value is not None else '未记录'
        parts.append(f'用量：输入 {tokens("inputTokens")}；缓存 {tokens("cachedInputTokens")}；输出 {tokens("outputTokens")} Token')
        if usage.get('elapsedMs') is not None:
            parts.append(f'耗时：{usage["elapsedMs"] / 1000:.2f} 秒')
        if usage.get('error'):
            parts.append(f'错误：{text(usage["error"])[:500]}')
    return cell(parts)


def event_cell(event):
    parts = ['已完成的模拟事件' if not event.get('rebuiltAt') else '重生成的模拟经历',
             event.get('summary')]
    for field, label in [('feeling', '感受'), ('step', '下一步'), ('learning', '经验'), ('shareThought', '想聊的事')]:
        if event.get(field):
            parts.append(f'{label}：{event[field]}')
    return cell(parts)


def weekly_roster(state, now):
    monday = now.date() - dt.timedelta(days=now.weekday())
    sunday = monday + dt.timedelta(days=6)
    plan = state.get('week-plan:' + monday.isoformat())
    lines = ['', '## 本周班表', '', f'{monday} 至 {sunday}（北京时间）', '']
    if not plan:
        return lines + ['本周班表尚未生成；由本周首次心跳检查补齐，不沿用上周班表。']
    days = {row['day']: row for row in plan.get('days', [])}
    lines += [f'生成时间：{stamp(plan.get("generatedAt"))}；周内班次固定。以下为安排，不代表活动已经发生。', '',
              '| 日期 | 星期 | 班次时间 |', '| --- | --- | --- |']
    for offset, weekday in enumerate('一二三四五六日'):
        day = (monday + dt.timedelta(days=offset)).isoformat()
        label = cell([days.get(day, {}).get('label')])
        lines += [f'| {day} | 星期{weekday} | {label} |']
    return lines


def render(snapshot, results, now=None):
    now = (now or dt.datetime.now(ZONE)).astimezone(ZONE)
    state = snapshot['state']
    world = state.get('world') or {}
    activity = world.get('activity') or {}
    attempts = snapshot['attempts']
    heartbeats = snapshot.get('heartbeats', [])
    audits = {row['attemptId']: row for row in heartbeats if row.get('attemptId')}
    today = now.strftime('%Y-%m-%d')
    today_rows = [a for a in attempts if a['day'] == today]
    events = {e['id']: {**json.loads(e['value']), '_meaningful': bool(e['meaningful'])} for e in snapshot['events']}
    rebuilds = {key.removeprefix('rebuild:'): value for key, value in state.items() if key.startswith('rebuild:')}
    runtime = snapshot.get('runtime', {})
    backend = runtime.get('backend', 'codex')
    model = runtime.get('apiModel', 'gpt-6.1-sol') if backend == 'api' else runtime.get('codexModel', 'gpt-6-luna')
    lines = ['# 阮阮心跳记录', '',
             f'最后同步：{now.strftime("%Y-%m-%d %H:%M:%S")}（北京时间）', '',
             '本文件自动覆盖更新，汇总心跳用量和模拟生活事件；指定日期按重生成结果展示。记录变化后约 5 秒同步；查看时重新打开或刷新文件。',
             '只读取服务器已有数据，不调用模型、不发送微信、不改变人格或记忆。生活内容属于角色模拟事件。', '',
             '## 当前运行规则', '',
             f'- 通道：{backend}；模型：{model}；思考强度：Medium。',
             '- 每 7 分钟检查状态；模型按需调用，两次至少间隔 45 分钟，每天最多 24 次，睡眠期间不调用。',
             '- 每周一首个心跳检查生成周一至周日的班表，周内固定，不调用模型；停机错过时，在首次恢复检查补齐本周班表。',
             '- 每天 08:00 后按班表细化当天生活意向和可选兴趣，同一天不反复重抽，不额外调用模型；已发生的事实不改写。',
             '- 连续平淡时提供可选的小事线索；仍可继续原安排。具体经历与感受在动作完成后才写入，不把想法当成完成。',
             '- 心跳由独立服务运行，不随微信聊天或 /Q 取消；生活状态已改变时，过期提议不写回。',
             '- 这里只记录已有的活动、事件和简短感受，不包含模型内部推理。', '',
             '## 最新生活状态', '',
             f'- 时段：{PHASE.get(world.get("phase"), world.get("phase", "暂无"))}',
             f'- 活动：{text(activity.get("text")) or "暂无"}',
             f'- 地点：{PLACE.get(activity.get("place"), activity.get("place", "暂无"))}',
             f'- 活动开始：{stamp(activity.get("since"))}',
             f'- 计划持续至：{stamp(activity.get("until"))}',
             f'- 心情：{text(world.get("feeling")) or "未单独记录"}']
    pending = world.get('pending')
    if pending:
        lines += [f'- 正在推进：{ACTION.get(pending.get("action"), text(pending.get("action")))}；预计结束：{stamp(pending.get("endsAt"))}。尚未记为完成。']
    if world.get('shareThought'):
        lines += [f'- 有点想聊的小事：{text(world["shareThought"].get("text"))}（只是谈资，不代表已经发消息）。']
    decision = world.get('lastDecision')
    if decision:
        lines += [f'- 最近行动判定：{DECISION.get(decision.get("outcome"), text(decision.get("outcome")))}；{text(decision.get("reason"))}']
    for goal in world.get('goals', []):
        lines += [f'- 目标：{text(goal.get("intention"))}', f'- 下一步：{text(goal.get("step"))}']
        if goal.get('learning'):
            lines += [f'- 已保留的经验：{text(goal["learning"])}']
    if state.get('next'):
        lines += [f'- 下次允许尝试的时间：{stamp(state["next"])}（仍需满足生活状态、间隔及每日额度限制）']
    lines += weekly_roster(state, now)
    plans = sorted((v for k, v in state.items() if k.startswith('day-plan:')), key=lambda p: p['day'], reverse=True)
    usage = [json.loads(a['usage']) if a['usage'] else {} for a in today_rows]
    today_plan = next((p for p in plans if p['day'] == today), None)
    plan_usage = today_plan['usage'] if today_plan else {}
    lines += ['', '## 今日统计', '',
              f'- 日期：{today}；模型尝试 {len(today_rows)} / 24 次，其中采纳 {sum(a["status"] == "committed" for a in today_rows)} 次。',
              f'- 输入 Token：{sum(u.get("inputTokens") or 0 for u in usage):,}；其中缓存输入：{sum(u.get("cachedInputTokens") or 0 for u in usage):,}。',
              f'- 输出 Token：{sum(u.get("outputTokens") or 0 for u in usage):,}（按已记录用量汇总，进行中的调用可能尚未结算）。',
              f'- 当日意向底板：{"已有" if today_plan else "尚未生成"}；额外输入 {plan_usage.get("inputTokens") or 0:,} Token；输出 {plan_usage.get("outputTokens") or 0:,} Token，不计为完成事件。', '',
              '## 每日时间轴（日期从新到旧）', '',
              '“已采纳”表示结果已写入状态；“未采纳”表示结果没有生效；进行中不代表已完成。',
             '每次心跳按“数值、增减、原因”三行展示，每项参数独立一列。增减为较上次心跳的变化；首条采样参照本次结算前。',
             '原因只引用已有记录；没有变化写“无变化”，没有保存具体原因写“未单独记录”。心情背景不等于本次变化原因。历史缺失项不回填。',
              '每天按时间顺序展开；整点为时间刻度，实际心跳及完成事件保留到秒。尚未发生的时段只列时间，其余留空。', '']
    visible = [a for a in attempts if a['day'] not in rebuilds or a['at'] > rebuilds[a['day']]['through']]
    entries = [(a['at'], 'attempt', a) for a in visible]
    entries += [(row['at'], 'check', row) for row in heartbeats if not row.get('attemptId')]
    # A completed action belongs at its actual event time, not at the earlier
    # model proposal's timestamp. Future plans never populate event cells.
    entries += [(event['at'], 'event', event) for event in events.values()]
    entries = [item for item in entries if item[0] <= now.timestamp() * 1000]
    days = {today} | {p['day'] for p in plans} | set(rebuilds) | {stamp(at)[:10] for at, _, _ in entries}
    for day in sorted((day for day in days if day <= today), reverse=True):
        lines += [f'## {day}', '']
        rebuilt = rebuilds.get(day)
        if rebuilt:
            usage = rebuilt.get('usage') or {}
            lines += [f'本日模拟经历于 {stamp(rebuilt["generatedAt"])} 重生成；重建输入 {usage.get("inputTokens") or 0:,}、'
                      f'输出 {usage.get("outputTokens") or 0:,} Token。', '']
        base = dt.datetime.fromisoformat(day).replace(tzinfo=ZONE).timestamp() * 1000
        day_entries = [(at, kind, value) for at, kind, value in entries if stamp(at)[:10] == day]
        occupied = {int(at // 1000) for at, _, _ in day_entries}
        ticks = [(base + hour * 3600000, 'empty', None) for hour in range(25)
                 if int((base + hour * 3600000) // 1000) not in occupied]
        headers = ['时间', '事件发生', '项目'] + [label for label, _ in PARAMETERS]
        lines += ['| ' + ' | '.join(headers) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |']
        for at, kind, value in sorted(day_entries + ticks, key=lambda item: item[0]):
            label = '24:00' if at == base + 24 * 3600000 else stamp(at)[11:]
            if kind == 'empty':
                lines += ['| ' + ' | '.join([label[:5]] + [''] * (len(headers) - 1)) + ' |']
                continue
            entry, historical = None, None
            if kind == 'check':
                description = cell(['本地心跳检查', '模型调用：无'])
                entry = value
            elif kind == 'event':
                description = event_cell(value)
                lines += ['| ' + ' | '.join([label, description + '；未保存事件时刻的独立参数快照']
                                           + [''] * (len(headers) - 2)) + ' |']
                continue
            else:
                result = results.get(value['id'], {})
                description = attempt_cell(value, result)
                entry, historical = audits.get(value['id']), result.get('metrics')
            note = parameter_note(entry, historical)
            for index, (row_label, values) in enumerate(parameter_rows(entry, historical, snapshot.get('ledger', []))):
                row = [label if index == 0 else '', description if index == 0 else note if index == 2 else '', row_label]
                lines += ['| ' + ' | '.join(row + [cell([value]) for value in values]) + ' |']
        lines += ['']
    return '\n'.join(lines)


def write_document(content):
    # Same-directory atomic replacement keeps readers from seeing a half-written file.
    descriptor, temporary = tempfile.mkstemp(prefix='.心跳记录-', suffix='.tmp', dir=OUTPUT.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            handle.write(content)
        os.chmod(temporary, 0o664)
        os.replace(temporary, OUTPUT)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--data', type=Path, default=DATA)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    globals().update(DATA=args.data.expanduser().resolve(), OUTPUT=args.output.expanduser().absolute())
    previous = None
    while True:
        snapshot = read_snapshot()
        signature = dt.datetime.now(ZONE).strftime('%Y-%m-%d') + hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
        if signature != previous or not OUTPUT.exists():
            results = read_results({a['id'] for a in snapshot['attempts']})
            write_document(render(snapshot, results))
            previous = signature
            print(f'Updated {OUTPUT}; {len(snapshot["attempts"])} heartbeat records', flush=True)
        if args.once:
            return
        time.sleep(5)


if __name__ == '__main__':
    main()
