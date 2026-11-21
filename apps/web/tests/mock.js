// Installs a scripted mock of the ClearLedger HTTP contract on a Playwright page. Tests
// mutate `store.state` between steps and push one-shot overrides via `queue(path, fn)` to
// script a failure followed by a retry, without ever hitting a real backend.
export function installApi(page, { config, state }) {
  const store = { config, state, requests: [] };
  const queues = new Map();

  function queue(method, path, responder) {
    const key = method + ' ' + path;
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(responder);
  }

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\//, '');
    const method = req.method();
    store.requests.push({ method, path, headers: req.headers(), body: req.postData() });

    const key = method + ' /' + path.replace(/\/[^/]+\/investigate$/, '/:id/investigate').replace(/\/[^/]+\/review$/, '/:id/review');
    const scripted = queues.get(key)?.shift();
    if (scripted) return scripted(route, req);

    if (method === 'GET' && path === 'state') return route.fulfill({ json: store.state });
    if (method === 'GET' && path === 'config') return route.fulfill({ json: store.config });
    if (method === 'POST' && path === 'demo') return route.fulfill({ json: { status: 'loaded' } });
    if (method === 'POST' && path === 'import') return route.fulfill({ json: { status: 'imported' } });
    if (method === 'GET' && path === 'export') return route.fulfill({ json: store.state });
    if (method === 'POST' && /^cases\/[^/]+\/investigate$/.test(path)) return route.fulfill({ status: 502, json: { error: 'No scripted investigate response for this test' } });
    if (method === 'POST' && /^cases\/[^/]+\/review$/.test(path)) return route.fulfill({ json: { status: 'reviewed' } });
    return route.fulfill({ status: 404, json: { error: 'unhandled mock path: ' + key } });
  }

  return {
    store,
    queue,
    async install() { await page.route('**/api/**', handle); },
  };
}
