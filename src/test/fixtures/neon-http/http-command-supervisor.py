"""Linux HTTP fixture commands only: durable adoption, pidfd signals, own reaping.

No service manager, group signals, external packages or host configuration. The
control descriptor is closed in the command; EOF survives caller exit even when
command descendants inherit stdout/stderr. ECHILD, not a /proc sample, proves
completion. Deliberately killing this supervisor with SIGKILL is out of scope.
"""
import ctypes
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

report_path, ephemeral, owner_pid, owner_start, timeout, label, *command = sys.argv[1:]
owner_pid, timeout = int(owner_pid), float(timeout) / 1000
report = {'processes': [], 'termination': [], 'reaped': [], 'failures': [], 'complete': False}
owned = {}
stopping = None
leader = None
leader_status = None
control = 3

def identity(pid):
    try:
        path = Path('/proc') / str(pid)
        fields = (path / 'stat').read_text().rsplit(') ', 1)[1].split()
        return {'pid': int(pid), 'ppid': int(fields[1]), 'pgid': int(fields[2]),
                'session': int(fields[3]), 'state': fields[0], 'startTime': fields[19],
                'command': (path / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace').strip()}
    except (OSError, ValueError, IndexError):
        return None

def same(item):
    current = identity(item['pid'])
    return current is not None and current['startTime'] == item['startTime']

def remember(item):
    owned[(item['pid'], item['startTime'])] = item

def capture():
    # Walk kernel child lists from the still-live subreaper. A missed transient
    # edge cannot lose a surviving orphan: the kernel reparents it here.
    todo = [report['supervisor']]
    seen = set()
    while todo:
        parent = todo.pop()
        if parent['pid'] in seen or not same(parent):
            continue
        seen.add(parent['pid'])
        try:
            children = Path(f"/proc/{parent['pid']}/task/{parent['pid']}/children").read_text().split()
        except (FileNotFoundError, ProcessLookupError):
            # procfs can return ENOENT or ESRCH if the verified parent exits
            # before this read. Kernel adoption and waitpid still own its children.
            continue
        for pid in children:
            item = identity(pid)
            if item and item['ppid'] == parent['pid'] and same(parent):
                remember(item)
                todo.append(item)

def save():
    report['processes'] = [{**item, 'gone': not same(item)} for item in owned.values()]
    temp = f'{report_path}.{os.getpid()}.tmp'
    try:
        Path(temp).write_text(json.dumps(report, indent=2))
        os.replace(temp, report_path)
    except OSError as error:
        message = f'Ownership evidence write failed: {error}'
        if message not in report['failures']:
            report['failures'].append(message)

# The pidfd pins the verified generation across the signal syscall itself.
def send(item, name):
    try:
        fd = os.pidfd_open(item['pid'])
    except ProcessLookupError:
        return
    try:
        if same(item):
            signal.pidfd_send_signal(fd, getattr(signal, name))
            report['termination'].append({'pid': item['pid'], 'startTime': item['startTime'], 'signal': name})
    except ProcessLookupError:
        pass
    finally:
        os.close(fd)

def request(reason):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        report['stopReason'] = reason

def interrupted(signum, _frame):
    request(signal.Signals(signum).name)

# Returns true only when the kernel confirms that NO waitable/live child exists.
def reap():
    global leader_status
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if pid == 0:
            return False
        report['reaped'].append({'pid': pid, 'waitStatus': status})
        if pid == leader.pid:
            leader_status = os.waitstatus_to_exitcode(status)
            leader.returncode = leader_status
            report['status'] = leader_status if leader_status >= 0 else None
            report['signal'] = signal.Signals(-leader_status).name if leader_status < 0 else None

def terminate(grace, killed):
    live = []
    for item in owned.values():
        current = identity(item['pid'])
        if current and current['startTime'] == item['startTime'] and current['state'] != 'Z':
            live.append(current)
    leaves = [item for item in live if not any(other['ppid'] == item['pid'] for other in live)]
    # Bottom-up grace, followed by a bounded all-descendant escalation. Adoption
    # plus waitpid allows safe reaping even if a parent exits before its children.
    for item in live if time.monotonic() - stopping > 6 else leaves:
        key = (item['pid'], item['startTime'])
        if key not in grace:
            send(item, 'SIGTERM')
            grace[key] = time.monotonic()
        elif key not in killed and time.monotonic() - grace[key] >= 1:
            send(item, 'SIGKILL')
            killed.add(key)

try:
    assert sys.platform == 'linux', 'HTTP command supervision requires Linux'
    assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'Linux pidfd support required'
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER, only this fixture process
        raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER')
    enabled = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
        raise RuntimeError('Subreaper admission failed')
    report['subreaper'] = True
    report['supervisor'] = identity(os.getpid())
    assert report['supervisor']['session'] == os.getpid(), 'Fresh detached fixture session required'
    for name in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(name, interrupted)
    # Probe actual pidfd support before launching anything.
    fd = os.pidfd_open(os.getpid())
    os.close(fd)
    owner = identity(owner_pid)
    if owner is None or owner['startTime'] != owner_start:
        request('caller exited before command admission')
    os.set_inheritable(control, False)
    os.set_blocking(control, False)
    if select.select([control], [], [], 0)[0]:
        request('control closed before command admission')
    if stopping is not None:
        raise RuntimeError('Command admission sealed')
    leader = subprocess.Popen(command, close_fds=True)
    report['leader'] = identity(leader.pid)
    remember(report['leader'])  # unreaped direct child, even if already a zombie
    save()
    started = time.monotonic()
    grace, killed = {}, set()
    while True:
        capture()
        empty = reap()
        if empty:
            report['complete'] = True
            break
        owner = identity(owner_pid)
        if owner is None or owner['startTime'] != owner_start:
            request('caller exited')
        readable, _, _ = select.select([control] if control is not None else [], [], [], 0.02)
        if readable:
            data = os.read(control, 4096)
            request('caller requested stop' if data else 'caller control EOF')
            if not data:
                os.close(control)
                control = None
        if leader_status is not None:
            request('command exited')
        if time.monotonic() - started >= timeout:
            if 'error' not in report:
                report['error'] = f'Owned child {label} timed out'
            request('timeout')
        if stopping is not None:
            terminate(grace, killed)
            if time.monotonic() - stopping >= 10:
                raise TimeoutError(f'Owned child tree survived termination: {label}')
        save()
except BaseException as error:
    if leader is None and stopping is not None:
        report['complete'] = True
        report['cancelledBeforeLaunch'] = True
    else:
        report['failures'].append(f'{type(error).__name__}: {error}')
    # Setup/observation failures must still tear down anything already launched.
    if leader is not None and not report['complete']:
        request('supervisor failure')
        grace, killed = {}, set()
        until = time.monotonic() + 10
        while time.monotonic() < until:
            capture()
            if reap():
                report['complete'] = True
                break
            terminate(grace, killed)
            time.sleep(.02)
finally:
    report['remaining'] = [item for item in owned.values() if same(item)]
    report['passed'] = report['complete'] and not report['remaining'] and not report['failures']
    save()
    # Ephemeral state has no external evidence consumer after caller death.
    owner = identity(owner_pid)
    if ephemeral == '1' and (owner is None or owner['startTime'] != owner_start) and report['passed']:
        Path(report_path).unlink(missing_ok=True)
        Path(report_path).parent.rmdir()
sys.exit(0 if report['passed'] else 1)
