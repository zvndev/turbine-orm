"""Independent admission for the required source and installed HTTP native scopes."""
import hashlib
import json
from pathlib import Path


CASES = {
    'actual network bindings and independent native write effects',
    'join and positional JSON decoding with parent and child global filters',
    'object JSON and actual flattened to-one join decoding',
    'native OIDs text values and bigint numeric date JSON array binary readings',
    'one pinned native transaction preserves batch ordering and commits effects',
    'middle failure rolls back first write and prevents third write with native errors',
    'native serializable read-only deferrable options and write refusal',
    'empty and invalid batches refuse without HTTP requests',
    'batch keeps admitted transforms when the caller replaces an entry after native commit',
    'callbacks session listener stream rowlock and nested write refusal before effects',
    'abort before request preserves exact reason and has no native effects',
    'abort during actual native query makes one request and no retry claim',
    'timeout after actual commit reports unknown outcome without retrying',
    'disconnect seals captured handles and restores caller ownership',
}
SCOPES = {
    'source-native': 'source',
    'actual-installed-esm': 'actual installed esm',
    'actual-installed-cjs': 'actual installed cjs',
    'omit-native-effect': 'actual installed esm',
    'corrupt-native-effect': 'actual installed esm',
}


def validate_positive(report, output):
    assert report['passed'] is True and report['phase'] == 'complete'
    assert report['failures'] == [] and report['interruptions'] == []
    assert not report.get('primaryFailure') and not report.get('cleanupFailures')
    assert report['rootGone'] is True and report['removedRoot'] == report['root']
    assert report['remainingClients'] == [] and report['remainingRelations'] == []
    assert report['archive']['pg'] == '8.15.0' and report['archive']['neon'] == '1.2.0'
    assert len(report['services']) == 1, 'One owned native PostgreSQL service required'
    service = report['services'][0]
    assert service['engine'] == 'postgresql' and service['server_version'] == '18.6'
    for field in ['stopped', 'connectionsClosed', 'pidGone', 'portClosed', 'socketGone', 'postmasterGone']:
        assert service[field] is True, f'Native service {field} must be true'
    assert not service.get('startupCleanupFailure')
    assert service['processes'] and service['pidAudit']
    assert all(item['gone'] is True for item in service['pidAudit'])

    commands = report['commands']
    labels = [command.get('label') for command in commands if command.get('label')]
    expected = set(SCOPES) | {
        'required-service-omission', 'required-driver-omission',
        'intercepted-protocol', 'install-actual-archive', 'actual-default-compatibility',
    }
    assert len(labels) == len(expected) and set(labels) == expected, 'Required native commands missing or duplicated'
    negative = {'required-service-omission', 'required-driver-omission', 'omit-native-effect', 'corrupt-native-effect'}
    for command in commands:
        assert command['pidGone'] is True and command['pid'] > 0
        assert command.get('signal') is None
        assert command['status'] == (1 if command.get('label') in negative else 0)
    assert any(Path(command.get('binary', '')).name == 'initdb' for command in commands)
    assert any(command.get('binary') == 'tar' for command in commands)

    references = report['nativeReports']
    assert len(references) == len(SCOPES) and {item['label'] for item in references} == set(SCOPES), 'Required native reports missing or duplicated'
    for item in references:
        label = item['label']
        path = Path(item['path'])
        assert path.resolve() == (Path(output) / f'{label}.json').resolve()
        raw = path.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item['sha256'], 'Native report hash mismatch'
        native = json.loads(raw)
        assert native['scope'] == SCOPES[label] and native['runtime'] == report['runtime']
        assert native['serverVersion'] == service['server_version']
        assert item['pidGone'] is True and native['pid'] == item['pid'] > 0
        assert native['pgid'] == item['pgid']
        command = next(command for command in commands if command.get('label') == label)
        # source-native uses a gate process that spawns the actual native contract.
        if label != 'source-native':
            assert command['pid'] == native['pid']
        for field in ['fetchRestored', 'configUnchanged']:
            assert native[field] is True, f'{label}: {field} must be true'
        assert native['bridge']['closed'] is True and native['bridge']['portClosed'] is True
        assert native['remainingObjects'] == []
        if label in negative:
            assert native['failures'], 'Negative native control must record its failure'
        else:
            assert len(native['cases']) == len(CASES) and set(native['cases']) == CASES, 'Required native cases missing or duplicated'
            assert native['failures'] == []
