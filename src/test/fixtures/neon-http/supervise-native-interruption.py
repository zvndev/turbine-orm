"""SIGINT/SIGTERM supervisor for the native HTTP bridge fixture.

Retains its /proc ownership and independent socket audits. Replaces timing guesses
with fixture barriers and removes every external service-rescue operation.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tarfile
import time
import shutil
from native_proof import validate_positive

source = Path(__file__).resolve().parents[4]
node, destination, scenario = sys.argv[1:4]
out = Path(destination).resolve()
out.mkdir()  # refuse reuse of any evidence or installed fixture
control = out / 'control'
control.mkdir()
env = {**os.environ, 'NEON_HTTP_EVIDENCE': str(out), 'NEON_HTTP_TEST_CONTROL': str(control)}
for key in ['NODE_TEST_CONTEXT', 'NEON_HTTP_NATIVE_URL', 'NEON_HTTP_ARCHIVE', 'NEON_HTTP_ARCHIVE_SHA256', 'NEON_HTTP_TEST_BARRIER']:
    env.pop(key, None)
phase, which = None, None
if scenario.startswith('signal:'):
    _, phase, which = scenario.split(':')
    env['NEON_HTTP_TEST_BARRIER'] = phase
elif scenario == 'positive':
    env['NEON_HTTP_ARCHIVE'] = os.environ['NEON_HTTP_ARCHIVE']
    env['NEON_HTTP_ARCHIVE_SHA256'] = os.environ['NEON_HTTP_ARCHIVE_SHA256']
elif scenario == 'missing-prefix':
    env.pop('PG_PREFIX', None)
elif scenario == 'missing-binary':
    env['PG_PREFIX'] = str(out / 'absent-pg')
else:
    assert scenario in ['wrong-sha', 'cleanup-error', 'cleanup-error-signal', 'cleanup-hang', 'remove-error', 'stubborn-signal', 'stubborn-parent-graceful', 'stubborn-timeout']
    if scenario in ['wrong-sha', 'cleanup-error', 'cleanup-error-signal', 'cleanup-hang']:
        env['NEON_HTTP_ARCHIVE'] = os.environ['NEON_HTTP_ARCHIVE']
        env['NEON_HTTP_ARCHIVE_SHA256'] = '0' * 64

# Only isolated copies are altered for failure controls. Source and shared helpers are read-only.
copy_hashes = {}
if scenario in ['cleanup-error', 'cleanup-error-signal', 'cleanup-hang', 'remove-error', 'stubborn-signal', 'stubborn-parent-graceful', 'stubborn-timeout']:
    fixture = out / 'source'
    fixture.mkdir()
    names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=source).decode().split('\0')
    names = set(filter(None, names))
    names.update(str(p.relative_to(source)) for p in (source / 'src/test/fixtures/neon-http').glob('*') if p.is_file())
    for name in names:
        original = source / name
        if not original.is_file():
            continue
        target = fixture / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target)
    (fixture / 'node_modules').symlink_to((source / 'node_modules').resolve(), target_is_directory=True)
    script = fixture / 'src/test/fixtures/neon-http/native-run.mjs'
    original = script.read_text()
    changed = original
    if scenario in ['cleanup-error', 'cleanup-error-signal']:
        changed = changed.replace('stops.push(stop);', "stops.push(async () => { await stop(); throw new Error('Deliberate owned cleanup failure'); });")
    elif scenario == 'cleanup-hang':
        changed = changed.replace('stops.push(stop);', 'stops.push(() => new Promise(() => {}));')
    elif scenario == 'remove-error':
        anchor = 'rmSync(root, { recursive: true, force: true });'
        changed = changed.replace(anchor, anchor + " throw new Error('Deliberate removal failure after deletion');")
    else:
        anchor = "await child('source-native', process.execPath, ['src/test/fixtures/neon-http/gate-run.mjs']);"
        changed = changed.replace(anchor, "await child('source-native', process.execPath, ['src/test/fixtures/neon-http/interruption-child.mjs']);")
        env['NEON_HTTP_TEST_BARRIER'] = 'stubborn-child'
        phase = 'stubborn-child'
        if scenario in ['stubborn-signal', 'stubborn-parent-graceful']:
            which = 'SIGTERM'
            if scenario == 'stubborn-parent-graceful':
                env['NEON_HTTP_TEST_PARENT_GRACEFUL'] = '1'
        else:
            changed = changed.replace('failure,\n', "failure, timeout: label === 'source-native' ? 1500 : 120_000,\n")
    if scenario == 'cleanup-error-signal':
        phase, which = 'report-finalization', 'SIGINT'
        env['NEON_HTTP_TEST_BARRIER'] = phase
    assert changed != original, 'Isolated control anchor must match'
    script.write_text(changed)
    copy_hashes = {'original': hashlib.sha256(original.encode()).hexdigest(), 'control': hashlib.sha256(changed.encode()).hexdigest()}
    source = fixture

log = (out / 'console.log').open('w')
command = [node, 'src/test/fixtures/neon-http/native-run.mjs']
proc = subprocess.Popen(command, cwd=source, env=env, stdout=log, stderr=log, start_new_session=True)
record = {'scenario': scenario, 'command': command, 'cwd': str(source), 'runnerPid': proc.pid,
          'runnerPgid': os.getpgid(proc.pid), 'copyHashes': copy_hashes, 'externalRescue': False}
owned = {}
services = {}
bridge_ports = set()

def processes():
    result = []
    for path in Path('/proc').glob('[0-9]*'):
        try:
            stat = (path / 'stat').read_text().split(') ')[1].split()
            result.append({'pid': int(path.name), 'ppid': int(stat[1]), 'pgid': int(stat[2]),
                           'state': stat[0], 'startTime': stat[19],
                           'command': (path / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')})
        except (OSError, ValueError, IndexError):
            pass
    return result

def observe():
    current = processes()
    chosen = {p['pid'] for p in current if p['pgid'] == proc.pid or
              (p['pid'] in owned and p['startTime'] == owned[p['pid']]['startTime'])}
    while True:
        more = {p['pid'] for p in current if p['ppid'] in chosen}
        if more <= chosen:
            break
        chosen |= more
    for item in current:
        if item['pid'] in chosen:
            owned[item['pid']] = item
    try:
        report = json.loads((out / 'native-report.json').read_text())
        for item in report.get('services', []):
            services[item['pid']] = item
    except (FileNotFoundError, json.JSONDecodeError):
        pass

def open_port(port):
    try:
        with socket.create_connection(('127.0.0.1', port), 1):
            return True
    except ConnectionRefusedError:
        return False

# A live caller-owned socket, in the caller's group, must survive every run.
witness = socket.socket()
witness.bind(('127.0.0.1', 0))
witness.listen()
witness_port = witness.getsockname()[1]
record['callerWitness'] = {'pid': os.getpid(), 'pgid': os.getpgrp(), 'port': witness_port}
def interrupted(signum, _frame):
    received = record.setdefault('supervisorSignals', [])
    received.append(signum)
    if len(received) == 1:
        raise InterruptedError(f'Supervisor received signal {signum}')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
try:
    deadline = time.monotonic() + 150
    sent = False
    while proc.poll() is None:
        observe()
        if phase and not sent and (control / f'{phase}.ready.json').exists():
            ready = json.loads((control / f'{phase}.ready.json').read_text())
            if 'bridge' in ready:
                bridge_ports.add(ready['bridge']['port'])
                assert open_port(ready['bridge']['port']), 'Native HTTP bridge must actually be live'
            if phase == 'service-initialization':
                assert services and all(Path('/proc', str(item['pid'])).exists() for item in services.values())
            if phase in ['initialization', 'active-native-child', 'final-cleanup']:
                assert services, 'Native PG must actually be owned and live'
                for item in services.values():
                    assert open_port(item['port'])
                    assert Path(item['datadir'], 'postmaster.pid').exists()
                    assert str(out) in item['datadir']
            record['beforeSignalReportPassed'] = json.loads((out / 'native-report.json').read_text())['passed']
            if phase == 'report-written':
                assert record['beforeSignalReportPassed'] is True, 'Hold a real successful report before interrupting'
            record['barrier'] = ready
            record['processesWhileAlive'] = list(owned.values())
            (out / 'live-ownership.json').write_text(json.dumps(record, indent=2))
            if which:
                proc.send_signal(getattr(signal, which))
            sent = True
        assert time.monotonic() < deadline, 'Runner did not exit within the acceptance bound'
        time.sleep(.01)  # condition polling only; phase selection is the explicit ready barrier
    record['runnerExit'] = proc.wait()
    observe()
    if phase:
        assert sent, 'Deterministic barrier was never reached'
    report = json.loads((out / 'native-report.json').read_text())
    record['reportSha256'] = hashlib.sha256((out / 'native-report.json').read_bytes()).hexdigest()
    if which:
        assert record['runnerExit'] == {'SIGINT': 130, 'SIGTERM': 143}[which], record
        assert report['passed'] is False
        assert report['interruptions'][0]['signal'] == which
        if scenario == 'cleanup-error-signal':
            assert 'AssertionError' in report['primaryFailure']
            assert 'Deliberate owned cleanup failure' in '\n'.join(report['failures'])
        else:
            assert f'Interrupted by {which}' in report['primaryFailure']
    elif scenario == 'positive':
        assert record['runnerExit'] == 0 and report['passed'] is True, report['failures']
        archive = Path(os.environ['NEON_HTTP_ARCHIVE']).resolve()
        archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
        assert archive_sha == os.environ['NEON_HTTP_ARCHIVE_SHA256'] == report['archive']['sha256']
        with tarfile.open(archive) as package:
            dist_files = [item.name for item in package.getmembers()
                          if item.isfile() and item.name.startswith('package/dist/')]
        assert dist_files and report['archive']['distFiles'] == len(dist_files)
        validate_positive(report, out)
    else:
        assert record['runnerExit'] == 1 and report['passed'] is False, report
        expected = {'missing-prefix': 'PG_PREFIX', 'missing-binary': 'AssertionError',
                    'wrong-sha': 'AssertionError', 'cleanup-error': 'Deliberate owned cleanup failure',
                    'cleanup-hang': 'teardown exceeded', 'remove-error': 'Deliberate removal failure',
                    'stubborn-timeout': 'timed out'}[scenario]
        assert expected in '\n'.join(report['failures']), report['failures']
        if scenario in ['cleanup-error', 'cleanup-hang']:
            assert 'AssertionError' in report['primaryFailure'], 'Cleanup must preserve original archive-pin failure'
    if scenario in ['wrong-sha', 'cleanup-error', 'cleanup-error-signal', 'cleanup-hang']:
        assert '0' * 64 in report['primaryFailure'], 'Must reach the actual archive SHA refusal'
        assert len(report['services']) == 1
        assert any(c.get('label') == 'source-native' and c.get('status') == 0 for c in report['commands'])
    if scenario == 'missing-binary':
        assert any(c['binary'] == str(out / 'absent-pg/bin/initdb') and c['status'] is None for c in report['commands'])
    if scenario.startswith('stubborn'):
        killed = [t for c in report['commands'] for t in c.get('termination', []) if t['signal'] == 'SIGKILL']
        assert len(killed) >= (1 if scenario == 'stubborn-parent-graceful' else 2), 'Owned SIGTERM-ignoring processes must require escalation'
    record['pidAudit'] = [{'recorded': item, 'gone': not Path('/proc', str(item['pid'])).exists()} for item in owned.values()]
    record['serviceAudit'] = [{'pid': item['pid'], 'portClosed': not open_port(item['port']),
                              'datadirGone': not Path(item['datadir']).exists(),
                              'socketGone': not Path(item['socket']).exists()} for item in services.values()]
    record['bridgeAudit'] = [{'port': port, 'closed': not open_port(port)} for port in bridge_ports]
    assert all(item['gone'] for item in record['pidAudit']), record['pidAudit']
    assert all(item['portClosed'] and item['datadirGone'] and item['socketGone'] for item in record['serviceAudit'])
    assert all(item['closed'] for item in record['bridgeAudit'])
    assert not Path(report['root']).exists() and report['rootGone'] is True
    assert open_port(witness_port), 'Caller-owned socket must survive'
    record['passed'] = True
except BaseException as error:
    record['passed'] = False
    record['error'] = repr(error)
    raise
finally:
    # No pg_ctl, no service signals, no process-group kills, and no service-root deletion.
    # On harness failure only ask the runner itself to execute its owned teardown.
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=40)
        except subprocess.TimeoutExpired:
            record['runnerStillAlive'] = True
    observe()
    record['allObservedProcesses'] = list(owned.values())
    log.close()
    witness.close()
    (out / 'signal-audit.json').write_text(json.dumps(record, indent=2))
print(json.dumps({'scenario': scenario, 'exit': record['runnerExit'], 'passed': record['passed'], 'externalRescue': False}))
