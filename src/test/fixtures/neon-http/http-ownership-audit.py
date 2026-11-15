"""Cancellation audit: observe independently, never signal/rescue command descendants.

Adopts and waits for the detached supervisor ONLY after the Node caller dies.
The command supervisor must have reaped every one of its own children itself.
"""
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

node, destination, name = sys.argv[1:]
root = Path(destination)
root.mkdir()
assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
fixture = Path(__file__).with_name('http-ownership-child.mjs')
record = {'externalRescue': False, 'adoptedReaping': [], 'processes': [], 'passed': False}

def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
        return {'pid': int(pid), 'ppid': int(fields[1]), 'pgid': int(fields[2]), 'startTime': fields[19]}
    except (OSError, IndexError):
        return None

def same(item):
    current = identity(item['pid'])
    return current and current['startTime'] == item['startTime']

def ready(path):
    until = time.monotonic() + 12
    while not path.exists():
        assert time.monotonic() < until, f'Missing live ready barrier {path}'
        assert proc.poll() is None, 'Caller ended before readiness'
        time.sleep(.01)
    return json.loads(path.read_text())

def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), 1):
            return True
    except ConnectionRefusedError:
        return False

witness = socket.socket()
witness.bind(('127.0.0.1', 0))
witness.listen()
record['witness'] = {**identity(os.getpid()), 'port': witness.getsockname()[1]}
def interrupted(signum, _frame):
    received = record.setdefault('auditSignals', [])
    received.append(signum)
    if len(received) == 1:
        raise InterruptedError(f'Audit interrupted by {signum}')

for caught_signal in [signal.SIGINT, signal.SIGTERM]:
    signal.signal(caught_signal, interrupted)

log = (root / 'caller.log').open('w')
proc = subprocess.Popen([node, str(fixture), 'caller', str(root), name], stdout=log, stderr=log)
record['caller'] = identity(proc.pid)
try:
    record['stalledCaller'] = ready(root / 'caller-stalled.json')
    leaf = ready(root / 'leaf.json')
    proof = ready(root / 'command.log.ownership.json')
    record['liveProof'] = proof
    record['leafWhileAlive'] = leaf
    record['processes'] = [record['caller'], proof['supervisor'], *proof['processes'], leaf]
    assert same(leaf) and listening(leaf['port'])
    assert record['caller']['pgid'] == record['witness']['pgid'], 'Same-group external witness required'
    # The only signal issued by this audit is the requested invocation cancellation.
    fd = os.pidfd_open(proc.pid)
    try:
        assert same(record['caller'])
        signal.pidfd_send_signal(fd, getattr(signal, name))
    finally:
        os.close(fd)
    record['callerExit'] = proc.wait(timeout=5)
    assert record['callerExit'] == -getattr(signal, name)
    until = time.monotonic() + 15
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid:
            record['adoptedReaping'].append({'pid': pid, 'status': status})
            assert pid == proof['supervisor']['pid'], 'Supervisor failed to reap its own command descendant'
            assert os.waitstatus_to_exitcode(status) == 0
        assert time.monotonic() < until, 'Cancelled invocation did not clean up in bound'
        time.sleep(.01)
    final = json.loads((root / 'command.log.ownership.json').read_text())
    record['finalProof'] = final
    assert final['passed'] and final['complete'] and final['remaining'] == []
    record['processes'] += final['processes']
    record['absence'] = [{'identity': item, 'absent': not same(item)} for item in record['processes']]
    assert all(item['absent'] for item in record['absence'])
    assert not listening(leaf['port']) and listening(record['witness']['port'])
    record['passed'] = True
finally:
    # A failed/cancelled audit still cancels its own invocation, then gives the
    # independent command owner its bounded cleanup window. No descendant or
    # process-group rescue signal is issued here, and this cannot become a pass.
    if proc.poll() is None:
        record['externalRescue'] = True
        record['passed'] = False
        if same(record['caller']):
            fd = os.pidfd_open(proc.pid)
            try:
                signal.pidfd_send_signal(fd, signal.SIGTERM)
            finally:
                os.close(fd)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            record['callerStillAlive'] = True
    until = time.monotonic() + 15
    while time.monotonic() < until:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid:
            record['adoptedReaping'].append({'pid': pid, 'status': status, 'duringFailureCleanup': True})
        else:
            time.sleep(.01)
    else:
        record['cleanupBoundExceeded'] = True
        record['passed'] = False
    log.close()
    witness.close()
    (root / 'audit.json').write_text(json.dumps(record, indent=2))
print(json.dumps({'scenario': name, 'passed': record['passed'], 'externalRescue': False}))
