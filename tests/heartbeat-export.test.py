import importlib.util
import json
from pathlib import Path
import re
import runpy
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('heartbeat_export', Path(__file__).resolve().parents[1] / 'scripts/export-heartbeat.py')
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


HEADERS = '| 时间 | 事件发生 | 项目 | ' + ' | '.join(label for label, _ in export.PARAMETERS) + ' |'
EMPTY_SUFFIX = ' | ' * (len(export.PARAMETERS) + 2) + ' |'


def at(value):
    return int(export.dt.datetime.fromisoformat(value + '+08:00').timestamp() * 1000)


class HeartbeatExportTests(unittest.TestCase):
    def test_default_data_is_the_character_app_and_environment_can_select_another_root(self):
        script=Path(__file__).resolve().parents[1]/'scripts/export-heartbeat.py'
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.dict(export.os.environ,{},clear=True),patch.object(Path,'home',return_value=root):
                loaded=runpy.run_path(str(script))
                self.assertEqual(loaded['DATA'],root/'.wechat-codex-desktop/app')
            with patch.dict(export.os.environ,{'WCB_DATA_DIR':str(root/'selected-app')}):
                loaded=runpy.run_path(str(script))
                self.assertEqual(loaded['DATA'],root/'selected-app')

    def test_current_week_roster_is_shown_once_without_rewriting_stored_shifts(self):
        snapshot = {'state': {}, 'events': [], 'runtime': {}, 'attempts': [], 'heartbeats': []}
        labels = ['历史排班未记录', '轮休', '早班 10:00–18:00', '晚班 13:00–21:30',
                  '早班 09:00–17:30', '晚班 13:00–21:30', '早班 09:00–17:30']
        plan = {'weekStart': '2026-11-02', 'weekEnd': '2026-11-08', 'timezone': 'Asia/Shanghai',
                'generatedAt': at('2026-11-05T08:07:00'), 'source': 'weekly_roster', 'days': []}
        for offset, label in enumerate(labels):
            day = f'2026-11-{offset + 2:02d}'
            plan['days'].append({'day': day, 'shift': None if offset == 0 else 'off' if offset == 1 else 'early', 'label': label})
        snapshot['state']['week-plan:2026-11-02'] = plan
        snapshot['state']['week-plan:2026-10-26'] = {'days': [{'day': '2026-10-26', 'label': '上周班次不展示'}]}
        snapshot['state']['week-plan:2026-11-09'] = {'days': [{'day': '2026-11-09', 'label': '下周班次不展示'}]}
        for day in ['2026-11-04', '2026-11-05']:
            snapshot['state']['day-plan:' + day] = {'day': day, 'usage': {}, 'slots': []}
        original = json.dumps(snapshot, sort_keys=True)
        doc = export.render(snapshot, {}, export.dt.datetime.fromisoformat('2026-11-05T10:30:00+08:00'))
        self.assertEqual(doc.count('## 本周班表'), 1)
        self.assertEqual(doc.count('| 日期 | 星期 | 班次时间 |'), 1)
        self.assertIn('| 2026-11-02 | 星期一 | 历史排班未记录 |', doc)
        self.assertIn('| 2026-11-04 | 星期三 | 早班 10:00–18:00 |', doc)
        self.assertIn('| 2026-11-08 | 星期日 | 早班 09:00–17:30 |', doc)
        self.assertIn('每周一首个心跳检查', doc)
        self.assertIn('首次恢复检查补齐本周班表', doc)
        self.assertIn('已发生的事实不改写', doc)
        self.assertNotIn('上周班次不展示', doc)
        self.assertNotIn('下周班次不展示', doc)
        self.assertEqual(doc.count(HEADERS), 2)
        self.assertNotIn('## 2026-11-08', doc)
        self.assertEqual(json.dumps(snapshot, sort_keys=True), original)

    def test_beijing_monday_without_a_new_roster_does_not_reuse_the_previous_week(self):
        snapshot = {'state': {'week-plan:2026-11-02': {
            'days': [{'day': '2026-11-02', 'label': '上周的早班'}]}},
            'events': [], 'runtime': {}, 'attempts': [], 'heartbeats': []}
        # Sunday UTC is already the next Monday in Beijing.
        doc = export.render(snapshot, {}, export.dt.datetime.fromisoformat('2026-11-08T16:01:00+00:00'))
        self.assertIn('2026-11-09 至 2026-11-15（北京时间）', doc)
        self.assertIn('本周班表尚未生成', doc)
        self.assertNotIn('上周的早班', doc)
        self.assertNotIn('| 日期 | 星期 | 班次时间 |', doc)
        self.assertIn('## 2026-11-09', doc)

    def test_dates_are_newest_first_and_each_day_is_one_forward_timeline(self):
        snapshot = {'state': {}, 'events': [], 'runtime': {}, 'attempts': [], 'heartbeats': []}
        for day in ['2026-11-03', '2026-11-05', '2026-11-04']:
            snapshot['state']['day-plan:' + day] = {'day': day, 'generatedAt': at(day + 'T08:00:00'), 'source': 'daily_routine', 'usage': {}, 'slots': []}
            snapshot['heartbeats'] += [{'at': at(day + 'T09:00:00')}, {'at': at(day + 'T10:00:00')}]
        doc = export.render(snapshot, {}, export.dt.datetime.fromisoformat('2026-11-05T10:30:00+08:00'))
        self.assertEqual(re.findall(r'^## (\d{4}-\d{2}-\d{2})$', doc, re.M), ['2026-11-05', '2026-11-04', '2026-11-03'])
        for day in ['2026-11-03', '2026-11-05', '2026-11-04']:
            section = doc.split('## ' + day + '\n')[1].split('\n## ')[0]
            self.assertLess(section.index('| 09:00:00 |'), section.index('| 10:00:00 |'))
            self.assertEqual(section.count(HEADERS), 1)
            self.assertIn('| 00:00' + EMPTY_SUFFIX, section)
            self.assertIn('| 24:00' + EMPTY_SUFFIX, section)
            self.assertNotIn('| 参数 |', section)

    def test_changes_include_between_heartbeat_chat_and_only_admin_affection(self):
        entry = {'before': {'energy': 62, 'finance': {'cash': 990}},
                 'after': {'energy': 60, 'finance': {'cash': 980}, 'administratorAffection': 119.5},
                 'previous': {'at': at('2026-11-05T09:00:00'), 'after': {'energy': 65, 'finance': {'cash': 1000}, 'administratorAffection': 119}}}
        rows = dict(export.parameter_rows(entry))
        self.assertEqual(rows['数值'][1:3], ['60.00', '980.00'])
        self.assertEqual(rows['增减'][1:3], ['-5.00', '-20.00'])
        self.assertEqual(rows['数值'][-1], '119.50')
        self.assertEqual(rows['增减'][-1], '+0.50')
        self.assertEqual(sum('好感度' in label for label, _ in export.PARAMETERS), 1)

    def test_historical_input_is_labeled_and_missing_numbers_are_not_invented(self):
        self.assertEqual(export.parameter_note(), '未保存参数快照')
        history = {'energy': 70}
        self.assertIn('历史模型输入快照', export.parameter_note(historical=history))
        rows = dict(export.parameter_rows(historical=history))
        self.assertEqual(rows['数值'][-1], '未记录')
        self.assertEqual(rows['数值'][1], '70.00')
        self.assertEqual(rows['增减'][1], '未记录')
        self.assertEqual(rows['原因'][1], '无对比记录')

    def test_reasons_use_matching_ledger_and_never_reuse_old_mood_background(self):
        before = {'at': 100, 'mood': {'value': 3.3, 'reason': '整理了桌子'},
                  'energy': 85, 'finance': {'cash': 100, 'reserved': 50, 'spendable': 50}}
        after = {'at': 200, 'mood': {'value': 3.21, 'reason': '整理了桌子'},
                 'energy': 85, 'finance': {'cash': 91, 'reserved': 50, 'spendable': 41}}
        entry = {'previous': {'after': before}, 'after': after}
        ledger = [{'at': 100, 'category': 'food', 'amount': -18, 'reason': '旧餐费'},
                  {'at': 150, 'category': 'food', 'amount': -9, 'reason': '日常餐饮'},
                  {'at': 201, 'category': 'rent', 'amount': -1500, 'reason': '未来房租'}]
        rows = dict(export.parameter_rows(entry, ledger=ledger))
        self.assertEqual(rows['原因'][:3], ['未单独记录', '无变化', '餐饮结算'])
        self.assertEqual(rows['原因'][4], '余额变化')
        self.assertEqual(dict(export.parameter_rows(entry))['原因'][2], '未单独记录')
        self.assertIn('心情背景：整理了桌子', export.parameter_note(entry))

    def test_future_rows_are_empty_and_completed_events_use_their_actual_time(self):
        day = '2026-11-05'
        snapshot = {'state': {'day-plan:' + day: {'day': day, 'generatedAt': at(day + 'T08:00:00'),
                     'source': 'daily_routine', 'usage': {}, 'slots': [{'from': '12:00', 'activity': '未来计划不能写入事件'}]}},
                    'events': [{'id': 'action', 'at': at(day + 'T09:20:00'), 'meaningful': 0,
                                'value': json.dumps({'id': 'action', 'at': at(day + 'T09:20:00'), 'summary': '确实完成的小事'})}],
                    'runtime': {}, 'attempts': [{'id': 'action', 'at': at(day + 'T09:00:00'), 'day': day, 'status': 'committed', 'usage': None}],
                    'heartbeats': [{'at': at(day + 'T12:00:00'), 'after': {'energy': 999}}]}
        results = {'action': {'delta': {'action': 'rest', 'detail': {'summary': '预计完成的描述'}, 'reason': '休息一下'}}}
        doc = export.render(snapshot, results, export.dt.datetime.fromisoformat(day + 'T10:30:00+08:00'))
        self.assertIn('| 12:00' + EMPTY_SUFFIX, doc)
        self.assertNotIn('999', doc)
        self.assertNotIn('未来计划不能写入事件', doc)
        self.assertNotIn('<br>', doc)
        for row_label in ('数值', '增减', '原因'):
            self.assertIn(' | ' + row_label + ' | ', doc)
        self.assertNotIn('预计完成的描述', doc)
        completed = next(line for line in doc.splitlines() if '确实完成的小事' in line)
        self.assertTrue(completed.startswith('| 09:20:00 |'))
        self.assertNotIn('确实完成的小事', next(line for line in doc.splitlines() if line.startswith('| 09:00:00 |')))


if __name__ == '__main__':
    unittest.main()
