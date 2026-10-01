/**
 * @file Progressive enhancement for Repot's MCP consent forms. Submit only to our
 * same-origin decision route, then perform top-level navigation to the server-
 * checked client handoff. This avoids cross-origin fetch/form redirect chains
 * without widening CSP. No authorization URLs, codes, cookies or tokens are logged.
 * Without JavaScript, the ordinary form returns an explicit client continuation link.
 */

/** Wire both decisions, prevent duplicate clicks, and keep failures visible without exposing provider data. */
export function installConsentForms(doc = document, send = fetch, navigation = window.location) {
  const forms = [...doc.querySelectorAll('form[data-oauth-consent]')];
  const buttons = forms.flatMap(form => [...form.querySelectorAll('button')]);
  const status = doc.getElementById('oauth-status');
  let pending = false;
  for (const form of forms) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending) return;
      pending = true;
      buttons.forEach(button => { button.disabled = true; });
      if (status) status.textContent = 'Processing your authorization decision…';
      try {
        const endpoint = new URL(form.action, navigation.href);
        if (endpoint.origin !== navigation.origin || endpoint.pathname !== '/consent/decision') throw new Error('Unexpected endpoint');
        const response = await send(endpoint.href, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { accept: 'application/json' },
          body: new URLSearchParams(new FormData(form))
        });
        if (!response.ok) throw new Error('Decision rejected');
        const result = await response.json();
        if (result?.redirect !== true || typeof result.url !== 'string') throw new Error('Missing handoff');
        const url = new URL(result.url);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw new Error('Invalid handoff');
        if (status) status.textContent = 'Returning to your app…';
        navigation.assign(url.href);
      } catch {
        if (status) status.textContent = 'Authorization could not finish. Return to your MCP client and click Connect again. Do not reuse this request.';
        pending = false;
        buttons.forEach(button => { button.disabled = false; });
      }
    });
  }
}

if (typeof document !== 'undefined') installConsentForms();
