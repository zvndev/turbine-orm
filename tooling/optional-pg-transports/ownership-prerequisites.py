"""Bounded admission probe only. The immutable HTTP supervisor owns commands."""
import ctypes
import json
import os
from pathlib import Path
import signal
import sys

try:
    if sys.platform != 'linux':
        raise RuntimeError('Linux ownership required')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('Kernel subreaper required')
    enabled = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
        raise RuntimeError('Subreaper admission failed')
    fd = os.pidfd_open(os.getpid())
    try:
        # Probe the syscall as well as Python's API before admitting a workload.
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
    fields = Path('/proc/self/stat').read_text().rsplit(') ', 1)[1].split()
    print(json.dumps({'pid': os.getpid(), 'startTime': fields[19], 'group': int(fields[2]),
                      'subreaper': True, 'pidfdSignalProbe': True}))
except BaseException as error:
    print(f'Ownership prerequisites failed: {type(error).__name__}: {error}', file=sys.stderr)
    sys.exit(1)
