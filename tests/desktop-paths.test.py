"""Relocation checks using temporary paths and a fake Codex executable."""
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]


class DesktopPathTests(unittest.TestCase):
    def test_python_defaults_use_current_home_and_preserve_explicit_data_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for name in ('wechat_gui.py','repair_workspace.py'):
                with patch.dict(os.environ,{},clear=True),patch.object(Path,'home',return_value=root):
                    self.assertEqual(runpy.run_path(str(ROOT/'desktop'/name))['DATA'],root/'.wechat-codex-desktop')
                with patch.dict(os.environ,{'WCB_DESKTOP_DATA':str(root/'explicit')}):
                    self.assertEqual(runpy.run_path(str(ROOT/'desktop'/name))['DATA'],root/'explicit')

    def test_launcher_resolves_its_relocated_directory_and_quotes_mcp_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);desktop=root/'project with "quotes"'/'desktop';desktop.mkdir(parents=True)
            launcher=desktop/'codex-wechat';shutil.copy2(ROOT/'desktop/codex-wechat',launcher)
            tools=root/'bin';tools.mkdir();fake=tools/'codex'
            fake.write_text('#!/usr/bin/python3\nimport json,os,sys\nprint(json.dumps({"args":sys.argv[1:],"data":os.environ["WCB_DESKTOP_DATA"]}))\n')
            fake.chmod(0o700)
            data=root/'selected data'
            env={**os.environ,'PATH':str(tools)+':/usr/bin:/bin','WCB_DESKTOP_DATA':str(data)}
            result=subprocess.run([str(launcher),'--help'],cwd=root,env=env,text=True,capture_output=True,check=True)
            value=json.loads(result.stdout);args=value['args']
            self.assertEqual(args[args.index('-C')+1],str(desktop))
            setting=next(arg for arg in args if arg.startswith('mcp_servers.wechat_desktop.args='))
            self.assertEqual(json.loads(setting.split('=',1)[1]),[str(desktop/'wechat_gui.py'),'mcp'])
            self.assertEqual(value['data'],str(data));self.assertEqual(args[-1],'--help')

    def test_relative_mcp_template_initializes_without_desktop_actions(self):
        config=tomllib.loads((ROOT/'desktop/.codex/config.toml').read_text())['mcp_servers']['wechat_desktop']
        with tempfile.TemporaryDirectory() as directory:
            result=subprocess.run([config['command'],*config['args']],cwd=ROOT/'desktop',
                env={**os.environ,'WCB_DESKTOP_DATA':directory,'PYTHONDONTWRITEBYTECODE':'1'},
                input=json.dumps({'jsonrpc':'2.0','id':1,'method':'initialize','params':{}})+'\n',
                text=True,capture_output=True,check=True,timeout=5)
            response=json.loads(result.stdout)
            self.assertEqual(response['id'],1);self.assertIn('capabilities',response['result'])
            self.assertEqual(list(Path(directory).iterdir()),[])


if __name__=='__main__':unittest.main()
