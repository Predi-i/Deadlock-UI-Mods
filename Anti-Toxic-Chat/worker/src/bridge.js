// HTTPS is required by CitadelHTMLPanel on the October 2026 game build.
// Requests live in the URL fragment; responses arrive through HTMLTitle.
export const BRIDGE_HTML = `<!doctype html><meta charset="utf-8"><title>AT_BOOT</title>
<script>
(() => {
  const seen = new Set();
  const reply = data => { document.title = 'AT2:' + JSON.stringify(data); };
  async function handle() {
    let request;
    try { request = JSON.parse(decodeURIComponent(location.hash.slice(1))); }
    catch (_) { return; }
    if (!request || typeof request.session !== 'string' || !Number.isInteger(request.id)) return;
    const key = request.session + ':' + request.id;
    if (seen.has(key)) return;
    seen.add(key);
    if (request.op === 'hello') {
      reply({op: 'ready', session: request.session, id: request.id, version: 2, href: location.href.split('#')[0]});
      return;
    }
    if (request.op !== 'transform' || typeof request.text !== 'string') return;
    let text = request.text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3200);
    try {
      const response = await fetch('/api/transform', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text}), signal: controller.signal
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (data && typeof data.text === 'string' && data.text.trim()) text = data.text.trim();
    } catch (_) { /* Preserve the existing original-message fallback. */ }
    finally { clearTimeout(timer); }
    reply({op: 'result', session: request.session, id: request.id, text: text.slice(0, 1000)});
  }
  window.addEventListener('hashchange', handle);
  handle();
})();
</script>`;
