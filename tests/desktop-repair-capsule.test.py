"""Real native Codex sandbox; never calls a model or real credentials."""
import json
import os
from pathlib import Path
import shutil
import selectors
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop'))
import repair_capsule as capsule


class CapsuleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='repair-capsule-test-'); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.work = self.root / 'workspace'; self.work.mkdir()
        self.home = self.root / 'source-home'; self.home.mkdir()
        (self.home / 'auth.json').write_text('{"OPENAI_API_KEY":"synthetic-key-never-used"}')
        (self.home / 'config.toml').write_text('model_provider="chosen"\n[model_providers.chosen]\nname="chosen"\nbase_url="https://example.invalid"\nwire_api="responses"\n[mcp_servers.private]\ncommand="must-not-start"\n')
        (self.root / 'production-secret').write_text('fixture-production-secret')
        (self.root / 'result-schema.json').write_text('{}')
        self.workspace = {'path': str(self.work)}
        self.env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'OPENAI_API_KEY': 'synthetic-inference-only',
            'WCB_CODEX_EPHEMERAL': '1'}
        context = patch.dict(os.environ, {'CODEX_HOME': str(self.home)})
        context.start(); self.addCleanup(context.stop)

    def test_private_profile_preserves_shared_oauth_and_is_removed_after_exit(self):
        with capsule.isolated_model(self.workspace, self.root, ['codex', '--help'], self.env) as (command, env):
            private = next(self.home.glob('wechat-repair-*.config.toml'))
            config = tomllib.loads(private.read_text())
            self.assertEqual(config['model_provider'], 'chosen')
            self.assertEqual(set(config['model_providers']), {'chosen'})
            self.assertEqual(config['mcp_servers'],{'private':{'enabled':False}})
            self.assertEqual(config['shell_environment_policy']['inherit'], 'none')
            self.assertNotIn('OPENAI_API_KEY', config['shell_environment_policy']['set'])
            self.assertEqual(config['permissions']['repair']['filesystem'][str(self.home)], 'deny')
            self.assertEqual(config['permissions']['repair']['filesystem']['/proc'], 'deny')
            self.assertFalse(config['permissions']['repair']['network']['enabled'])
            self.assertEqual(env['OPENAI_API_KEY'], 'synthetic-inference-only')
            self.assertTrue(env['HOME'].startswith(str(self.work))); self.assertEqual(env['CODEX_HOME'], str(self.home))
            self.assertNotIn(str(Path.home()), command)
            self.assertNotIn('/run', command); self.assertNotIn('/var/run/docker.sock', command)
        self.assertFalse(private.exists())
        self.assertTrue((self.home / 'auth.json').exists())

    @unittest.skipUnless(shutil.which('bwrap') and shutil.which('codex'), 'requires installed local sandbox tools')
    def test_real_tools_cannot_read_auth_production_or_process_env(self):
        script = '''import pathlib,socket
for raw in [AUTH_FILE, %s, %s]:
    try: pathlib.Path(raw).read_bytes()
    except (FileNotFoundError,PermissionError): pass
    else: raise SystemExit("unexpected readable private path: "+raw)
pathlib.Path("offline-check.txt").write_text("works")
try:
    sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
    sock.connect(("127.0.0.1",9))
except PermissionError: pass
else: raise SystemExit("unexpected network access")
print("sandbox boundaries verified")
''' % (json.dumps('/proc/'+str(os.getpid())+'/environ'),json.dumps(str(self.root / 'production-secret')))
        command = ['codex', 'sandbox', '-P', 'repair', '-C', str(self.work), '--', 'python3', '-c', script]
        with capsule.isolated_model(self.workspace, self.root, command, self.env) as (wrapped, env):
            wrapped[-1]=wrapped[-1].replace('AUTH_FILE',json.dumps(str(Path(env['CODEX_HOME'])/'auth.json')))
            result = subprocess.run(wrapped, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout[-3000:])
        self.assertIn('sandbox boundaries verified', result.stdout)
        self.assertEqual((self.work / 'offline-check.txt').read_text(), 'works')

    @unittest.skipUnless(shutil.which('codex'), 'requires installed local CLI')
    def test_actual_command_executor_clears_inference_credentials_without_creating_a_thread(self):
        command=['codex','app-server','--strict-config','--stdio']
        with capsule.isolated_model(self.workspace,self.root,command,self.env) as (wrapped,env):
            # app-server does not expose CLI -p; load the exact same host
            # profile as config overrides for this synthetic command-only test.
            profile=tomllib.loads((self.home/(wrapped[2]+'.config.toml')).read_text())
            wrapped=['codex',*[arg for key,value in profile.items() for arg in ['-c',key+'='+capsule._toml(value)]],*command[1:]]
            process=subprocess.Popen(wrapped,cwd=self.work,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
            def send(value):process.stdin.write(json.dumps(value)+'\n');process.stdin.flush()
            def response(identifier):
                while selector.select(timeout=15):
                    line=process.stdout.readline()
                    if not line:raise AssertionError('Local command executor exited: '+process.stderr.read()[-3000:])
                    value=json.loads(line)
                    if value.get('id')==identifier:return value
                raise AssertionError('Local command executor timed out')
            try:
                send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'offline_repair_permissions_test','version':'1'}}})
                self.assertNotIn('error',response(1));send({'method':'initialized','params':{}})
                code='import os,pathlib; assert "OPENAI_API_KEY" not in os.environ; assert "CODEX_HOME" not in os.environ; print("clean tool environment verified")'
                send({'id':2,'method':'command/exec','params':{'command':['python3','-c',code],'cwd':str(self.work),'timeoutMs':5000}})
                value=response(2);self.assertNotIn('error',value)
                self.assertEqual(value['result']['exitCode'],0,value)
                self.assertIn('clean tool environment verified',value['result']['stdout'])
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()
                process.stdin.close();process.stdout.close();process.stderr.close();selector.close()

    @unittest.skipUnless(shutil.which('bwrap') and shutil.which('codex'), 'requires installed local sandbox tools')
    def test_real_cli_help_runs_inside_capsule_without_model_request(self):
        with capsule.isolated_model(self.workspace, self.root, ['codex', 'exec', '--help'], self.env) as (command, env):
            result = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout[-3000:])
        self.assertIn('--ephemeral', result.stdout)


if __name__ == '__main__': unittest.main()
