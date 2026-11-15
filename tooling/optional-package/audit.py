"""Independent retained-process and service audit. Read-only; never signals."""
import glob
import json
import os
from pathlib import Path
import socket
import sys

root = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2])
reports = sorted(set(glob.glob(str(root / "logs/*.json")) + glob.glob(str(root / "*/report.json")) + glob.glob(str(root / "*/*/proof/report.json"))))
assert reports, "No ownership reports"
generations = set()
groups = set()
proofs = 0
services = []

def visit(value):
    global proofs
    if isinstance(value, dict):
        if "ownershipProof" in value:
            proof = value["ownershipProof"]
            assert proof["passed"] and proof["complete"] and proof["subreaper"], proof
            assert proof["remaining"] == [], proof
            proofs += 1
        for key in ("ownedProcesses",):
            for identity in value.get(key, []):
                generations.add((int(identity["pid"]), str(identity["startTime"])))
                groups.add(int(identity.get("pgid", identity.get("group"))))
        supervisor = value.get("supervisor")
        if isinstance(supervisor, dict) and "startTime" in supervisor:
            generations.add((int(supervisor["pid"]), str(supervisor["startTime"])))
            groups.add(int(supervisor["pgid"]))
        if value.get("engine") == "postgresql" and "datadir" in value:
            assert value["stopped"] and value["connectionsClosed"], value
            assert not Path(value["datadir"]).exists()
            assert not Path(value["socket"]).exists()
            services.append({"port": value["port"], "datadir": value["datadir"], "socket": value["socket"]})
        for item in value.values():
            visit(item)
    elif isinstance(value, list):
        for item in value:
            visit(item)

for report in reports:
    visit(json.loads(Path(report).read_text()))
assert proofs > 10
alive = []
live_groups = []
for entry in Path("/proc").iterdir():
    if not entry.name.isdigit():
        continue
    try:
        stat = (entry / "stat").read_text()
    except (FileNotFoundError, ProcessLookupError):
        continue
    fields = stat[stat.rfind(")") + 2:].split()
    identity = (int(entry.name), fields[19])
    if identity in generations:
        alive.append(identity)
    if int(fields[2]) in groups:
        live_groups.append((entry.name, fields[2]))
assert alive == [], alive
assert live_groups == [], live_groups
ports = sorted(set([57175, 57176] + [row["port"] for row in services]))
for port in ports:
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))
result = {"success": True, "reports": reports, "ownershipProofs": proofs, "pidGenerationsAbsent": len(generations), "groupsAbsent": len(groups), "portsBindable": ports, "servicesAbsent": services, "signalsSent": 0}
destination.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key not in ("reports", "servicesAbsent")}))
