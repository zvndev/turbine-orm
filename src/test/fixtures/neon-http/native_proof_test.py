"""Schema controls only; these synthetic records are not native execution evidence."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from native_proof import CASES, SCOPES, validate_positive


class NativeProof(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='http-proof-')
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name)
        commands = [
            {'label': label, 'pid': 100 + index, 'pidGone': True, 'status': 1 if label.endswith('native-effect') else 0}
            for index, label in enumerate(SCOPES)
        ]
        commands.extend({'label': label, 'pid': 200 + index, 'pidGone': True, 'status': 1 if label.endswith('omission') else 0}
                        for index, label in enumerate(['required-service-omission', 'required-driver-omission',
                            'intercepted-protocol', 'install-actual-archive', 'actual-default-compatibility']))
        commands.extend({'binary': binary, 'pid': 300 + index, 'pidGone': True, 'status': 0}
                        for index, binary in enumerate(['/fixture/bin/initdb', 'tar']))
        self.report = {
            'passed': True, 'phase': 'complete', 'runtime': 'v22.16.0', 'failures': [], 'interruptions': [],
            'rootGone': True, 'removedRoot': '/fixture/service', 'root': '/fixture/service',
            'remainingClients': [], 'remainingRelations': [], 'archive': {'pg': '8.15.0', 'neon': '1.2.0'},
            'services': [{'engine': 'postgresql', 'server_version': '18.6', 'stopped': True,
                          'connectionsClosed': True, 'pidGone': True, 'portClosed': True,
                          'socketGone': True, 'postmasterGone': True, 'processes': [{'pid': 400}],
                          'pidAudit': [{'pid': 400, 'gone': True}]}],
            'commands': commands, 'nativeReports': [],
        }
        for index, (label, scope) in enumerate(SCOPES.items()):
            native = {'scope': scope, 'runtime': 'v22.16.0', 'serverVersion': '18.6',
                      'pid': 100 + index, 'pgid': 42, 'fetchRestored': True, 'configUnchanged': True,
                      'bridge': {'closed': True, 'portClosed': True}, 'remainingObjects': [],
                      'cases': [] if label.endswith('native-effect') else sorted(CASES),
                      'failures': ['deliberate effect assertion'] if label.endswith('native-effect') else []}
            path = self.output / f'{label}.json'
            raw = json.dumps(native).encode()
            path.write_bytes(raw)
            self.report['nativeReports'].append({'label': label, 'path': str(path), 'pid': 100 + index,
                'pgid': 42, 'pidGone': True, 'sha256': hashlib.sha256(raw).hexdigest()})

    def reject(self, report):
        with self.assertRaises((AssertionError, KeyError, TypeError, ValueError)):
            validate_positive(report, self.output)

    def test_complete_schema(self):
        validate_positive(self.report, self.output)

    def test_absent_or_duplicate_scopes(self):
        for references in [[], self.report['nativeReports'][:-1], [self.report['nativeReports'][0]] * 5]:
            with self.subTest(references=references):
                self.reject({**self.report, 'nativeReports': references})

    def test_missing_native_ownership_and_commands(self):
        for field in ['services', 'commands']:
            with self.subTest(field=field):
                self.reject({**self.report, field: []})
        for field in ['stopped', 'connectionsClosed', 'pidGone', 'portClosed', 'socketGone', 'postmasterGone']:
            report = copy.deepcopy(self.report)
            report['services'][0][field] = False
            with self.subTest(field=field):
                self.reject(report)
        for change in ['missing', 'duplicate', 'failed', 'live', 'signal']:
            report = copy.deepcopy(self.report)
            if change == 'missing':
                report['commands'].pop(0)
            elif change == 'duplicate':
                report['commands'].append(report['commands'][0])
            else:
                key, value = {'failed': ('status', 1), 'live': ('pidGone', False), 'signal': ('signal', 'SIGTERM')}[change]
                report['commands'][0][key] = value
            with self.subTest(change=change):
                self.reject(report)

    def test_contradictory_success(self):
        for key, value in [('failures', ['failure']), ('primaryFailure', 'failure'),
                           ('cleanupFailures', ['cleanup']), ('interruptions', [{'signal': 'SIGTERM'}]),
                           ('remainingClients', [{'pid': 4}]), ('remainingRelations', ['http_fixture'])]:
            with self.subTest(field=key):
                self.reject({**self.report, key: value})

    def test_inner_native_proof(self):
        item = self.report['nativeReports'][0]
        path = Path(item['path'])
        baseline = json.loads(path.read_text())
        changes = [('cases', []), ('cases', baseline['cases'][:13]),
                   ('cases', [baseline['cases'][0]] * 14), ('fetchRestored', False), ('configUnchanged', False),
                   ('bridge', {'closed': False, 'portClosed': True}),
                   ('bridge', {'closed': True, 'portClosed': False}), ('remainingObjects', ['http_fixture']),
                   ('failures', ['native failure']), ('runtime', 'v24.10.0'), ('serverVersion', '17.0'),
                   ('scope', 'actual installed esm'), ('pid', 999)]
        for key, value in changes:
            raw = json.dumps({**baseline, key: value}).encode()
            path.write_bytes(raw)
            item['sha256'] = hashlib.sha256(raw).hexdigest()
            with self.subTest(field=key, value=value):
                self.reject(self.report)

    def test_hash_and_failed_control(self):
        item = self.report['nativeReports'][-1]
        path = Path(item['path'])
        native = json.loads(path.read_text())
        native['failures'] = []
        raw = json.dumps(native).encode()
        path.write_bytes(raw)
        self.reject(self.report)
        item['sha256'] = hashlib.sha256(raw).hexdigest()
        self.reject(self.report)


if __name__ == '__main__':
    unittest.main()
