"""Independent zero-signal audit of this lane's retained ownership records."""
import json
from pathlib import Path
import socket
import sys

root = Path(sys.argv[1]).resolve()
reports = sorted(set(root.glob('logs/*.json')) | set(root.glob('native-*/report.json')))
assert reports
generations = set()
groups = set()
proofs = set()
owners = set()
services = []

def visit(value):
    if isinstance(value, dict):
        proof = value.get('ownershipProof')
        if proof is not None:
            assert proof['passed'] and proof['complete'] and proof['subreaper'], proof
            assert proof['remaining'] == [], proof
            proofs.add(json.dumps(proof, sort_keys=True))
        for item in value.get('ownedProcesses', []):
            generations.add((int(item['pid']), str(item['startTime'])))
            groups.add(int(item.get('pgid', item.get('group'))))
        supervisor = value.get('supervisor')
        if isinstance(supervisor, dict) and 'startTime' in supervisor:
            generations.add((int(supervisor['pid']), str(supervisor['startTime'])))
            groups.add(int(supervisor['pgid']))
        for key, item in value.items():
            if isinstance(item, str) and '/optional-owned-' in item and item.startswith(str(root)):
                prefix, suffix = item.split('/optional-owned-', 1)
                owners.add(Path(prefix + '/optional-owned-' + suffix.split('/')[0]))
        if value.get('engine') == 'postgresql' and 'datadir' in value:
            assert value['stopped'] and value['connectionsClosed'], value
            assert not Path(value['datadir']).exists()
            assert not Path(value['socket']).exists()
            services.append({key: value[key] for key in ['port', 'datadir', 'socket']})
        for item in value.values():
            visit(item)
    elif isinstance(value, list):
        for item in value:
            visit(item)

for path in reports:
    visit(json.loads(path.read_text()))
assert len(proofs) >= 10
alive = []
live_groups = []
inaccessible = []
for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        stat = (entry / 'stat').read_text()
    except (FileNotFoundError, ProcessLookupError):
        continue
    except PermissionError:
        inaccessible.append(entry.name)
        continue
    fields = stat[stat.rfind(')') + 2:].split()
    identity = (int(entry.name), fields[19])
    if identity in generations:
        alive.append(identity)
    if int(fields[2]) in groups:
        live_groups.append((entry.name, fields[2]))
assert not alive, alive
assert not live_groups, live_groups
assert all(not path.exists() for path in owners), owners
assert not list((root / 'tmp').glob('optional-owned-*'))
ports = sorted({59851} | {row['port'] for row in services})
for port in ports:
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))
result = {'success': True, 'signalsSent': 0, 'reports': [str(path) for path in reports],
          'distinctCompleteProofs': len(proofs), 'pidGenerationsAbsent': len(generations),
          'groupsAbsent': len(groups), 'ownershipDirectoriesAbsent': len(owners),
          'portsBindable': ports, 'servicesAbsent': services, 'inaccessibleProcEntries': inaccessible}
Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: value for key, value in result.items() if key not in ['reports', 'servicesAbsent']}))
