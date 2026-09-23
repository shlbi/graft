"""Real HTTP/browser smoke test. Optional: Python + Playwright + an installed Chromium.
Run: python web/test/browser_smoke.py (from repository root).
No paid provider or external repositories are used. Screenshots capture the running app.
"""
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
DOCS.mkdir(exist_ok=True)
fixture = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {demoInput,demoRun} from './lib/demo.mjs'; console.log(JSON.stringify({input:demoInput,result:demoRun()}))"], cwd=ROOT))
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
# Do not inherit an inference configuration for the browser smoke test.
env = {**os.environ, 'PORT': str(port), 'OPENAI_API_KEY': '', 'GRAFT_AI_MODEL': ''}
server = subprocess.Popen(['node', 'server.mjs'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
checks = []
errors = []
try:
    assert 'Graft local web preview' in server.stdout.readline()
    with tempfile.TemporaryDirectory(prefix='graft-browser-') as temp, sync_playwright() as p:
        options = {'headless': True}
        executable = os.environ.get('GRAFT_CHROMIUM') or shutil.which('chromium')
        if executable:
            options['executable_path'] = executable
        browser = p.chromium.launch(**options)
        context = browser.new_context(viewport={'width': 1440, 'height': 1100}, device_scale_factor=1, reduced_motion='reduce', accept_downloads=True)
        page = context.new_page()
        page.on('pageerror', lambda err: errors.append(str(err)))
        base = f'http://127.0.0.1:{port}'
        page.goto(base, wait_until='networkidle')
        assert page.locator('#use-ai').is_disabled()
        assert page.locator('h1').inner_text() == 'Good features deserve\na second home.'
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        checks.append('desktop shell at 1440px; AI correctly disabled; no horizontal overflow')
        Image.open(io.BytesIO(page.screenshot(full_page=True))).convert('RGB').save(DOCS / 'web-home.webp', quality=65, method=6)
        page.locator('#try-demo').click()
        page.locator('#results').wait_for(state='visible')
        assert 'AUTHORED SAMPLE' in page.locator('#result-mode').inner_text()
        assert page.locator('#download-patch').is_disabled()
        assert page.locator('.change').count() == 2
        assert 'NOT RUN' in page.locator('#checks').inner_text()
        page.locator('#review-confirmation').check()
        with page.expect_download() as dl:
            page.locator('#download-patch').click()
        patch_path = Path(temp) / 'graft.patch'
        dl.value.save_as(patch_path)
        assert patch_path.read_text() == fixture['result']['review']['patch']
        with page.expect_download() as dl:
            page.locator('#download-report').click()
        report_path = Path(temp) / 'graft-review.json'
        dl.value.save_as(report_path)
        report = json.loads(report_path.read_text())
        assert report['review']['id'] == fixture['result']['review']['id']
        checks.append('real sample HTTP response; review gate; actual patch and JSON browser downloads match server output')
        Image.open(io.BytesIO(page.locator('#results').screenshot())).convert('RGB').save(DOCS / 'web-review.webp', quality=65, method=6)
        requests = []
        page.on('request', lambda req: requests.append(req.post_data_json) if req.url.endswith('/api/analyze') else None)
        for role in ['source', 'destination']:
            folder = Path(temp) / role
            for f in fixture['input'][role]['files']:
                target = folder / f['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(f['content'])
            (folder / '.env').write_text('EXAMPLE_ONLY_NOT_A_REAL_SECRET=excluded')
            (folder / 'node_modules').mkdir()
            (folder / 'node_modules' / 'ignored.js').write_text('ignored')
            page.locator(f'#{role}-folder').set_input_files(str(folder))
            page.wait_for_function("role => document.getElementById(role+'-hint').textContent.includes('text files')", arg=role)
        page.locator('#feature').fill('Move CSV export <img src=x onerror=window.injected=1>')
        page.locator('#analyze').click()
        page.wait_for_function("document.getElementById('result-mode').textContent === 'READ-ONLY REPOSITORY DISCOVERY' && !document.getElementById('results').hidden")
        assert page.locator('#candidates .match').count() > 0
        assert page.locator('#result-summary img').count() == 0
        assert not page.evaluate('Boolean(window.injected)')
        assert page.locator('#review-panel').is_hidden()
        assert requests[-1]['source']['kind'] == 'folder'
        for role in ['source', 'destination']:
            assert all(f['path'] != '.env' and 'node_modules' not in f['path'] for f in requests[-1][role]['snapshot']['files'])
            assert 'EXAMPLE_ONLY_NOT_A_REAL_SECRET' not in json.dumps(requests[-1])
        checks.append('two actual folder selections; browser filters excluded files before upload; real discovery; user text cannot inject HTML')
        page.locator('#feature').fill('New feature')
        assert page.locator('#results').is_hidden()
        checks.append('editing input invalidates previous review and downloads')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.goto(base, wait_until='networkidle')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('#try-demo').click()
        page.locator('#results').wait_for(state='visible')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        checks.append('390px mobile shell and populated review; no horizontal overflow')
        Image.open(io.BytesIO(page.screenshot(full_page=True))).convert('RGB').save(DOCS / 'web-mobile.webp', quality=65, method=6)
        assert not errors, errors
        checks.append('zero browser page errors')
        result = {'browser': 'Chromium ' + browser.version, 'transport': 'actual localhost HTTP', 'checks': checks, 'pageErrors': errors,
                  'externalGitHub': 'not exercised by this script', 'paidAI': 'not called', 'sampleReviewId': fixture['result']['review']['id']}
        (DOCS / 'browser-results.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
        browser.close()
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
