"""First acceptance check for a local Docker deployment with synthetic data only."""
import json
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[1]
settings = {}
if (root / '.env').exists():
    for line in (root / '.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            settings[key.strip()] = value.strip()
token = os.environ.get('API_TOKEN', settings.get('API_TOKEN', ''))
if not token:
    raise SystemExit('Set API_TOKEN in your environment or .env first.')
base = os.environ.get('CLEARLEDGER_BASE_URL', 'http://127.0.0.1:8080')

def request(path, method='GET'):
    req = Request(base + '/api/' + path, method=method,
                  headers={'Authorization': 'Bearer ' + token})
    with urlopen(req, timeout=10) as response:
        return json.load(response)

config = request('config')
assert config['storage'] == 'postgres', 'Expected the PostgreSQL deployment.'
assert config['kafka_configured'], 'Kafka must be configured.'
assert config['redis_configured'], 'Redis must be configured.'
state = request('state')
sample_ids = {'processor:ch_101','processor:ch_102','processor:ch_103',
              'processor:ch_104','processor:ch_105','processor:ch_106',
              'processor:re_106','processor:ch_107','bank:bn_201',
              'bank:bn_202','bank:bn_204a','bank:bn_204b','bank:bn_205',
              'bank:bn_206','bank:bn_207'}
if not state['records']:
    request('demo', 'POST')
elif set(state['records']) != sample_ids:
    raise SystemExit('Workspace is nonempty and not the sample. Use a separate test deployment.')
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    state = request('state')
    assert len(state['records']) == 15
    assert len(state['cases']) == 7
    assert sum(c['status'] == 'matched' for c in state['cases']) == 3
    exceptions = [c for c in state['cases'] if c['kind'] != 'matched']
    if all(c.get('proposal') for c in exceptions):
        print('PASS: 15 source records, seven payouts, three matches, four investigation drafts.')
        print('This is a startup/workflow check, not a crash-recovery or model-quality benchmark.')
        break
    time.sleep(2)
else:
    raise SystemExit('Worker drafts not ready. Inspect api/worker/Kafka logs and Ollama configuration.')
