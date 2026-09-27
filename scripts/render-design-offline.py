"""Offline layout review of authored sources. NOT HTTP/CSP/OAuth or deployment verification.
No navigation to a blocked URL, no policy overrides, no authenticated data or API doubles.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, re, argparse, shutil
root = Path(__file__).resolve().parents[1]
assets = root/'web/connected/public'
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=root/'.repot-evidence')
parser.add_argument('--chromium', default=shutil.which('chromium'))
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
html = (assets/'index.html').read_text()
html = re.sub(r'<link rel="stylesheet"[^>]*>', '', html)
html = re.sub(r'<script type="module"[^>]*></script>', '', html)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.chromium, headless=True)
    page = browser.new_page(viewport={'width':1440,'height':1000}, device_scale_factor=1, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content(html)
    page.add_style_tag(content=(assets/'style.css').read_text())
    page.add_script_tag(content=(assets/'app.mjs').read_text())
    page.wait_for_function("document.getElementById('connection-state').textContent === 'FRONTEND PREVIEW'")
    for width,height,name in [(1440,1000,'desktop'),(1024,768,'tablet'),(390,844,'mobile'),(320,700,'small')]:
        page.set_viewport_size({'width':width,'height':height})
        page.screenshot(path=str(output/f'repot-{name}.png'),full_page=True)
        results.append({'viewport':width,'documentWidth':page.evaluate('document.documentElement.scrollWidth'),'disabledComposer':page.locator('#feature').is_disabled()})
    page.set_viewport_size({'width':1440,'height':1000})
    page.locator('#desk').screenshot(path=str(output/'repot-workspace.png'))
    assert page.locator('#feature').is_disabled()
    assert page.locator('#source').is_disabled()
    assert page.locator('#create-draft').is_disabled()
    page.get_by_role('button',name='Tests',exact=True).click()
    assert page.locator('#anatomy-source').inner_text() == 'test/csv.test.ts'
    page.get_by_role('button',name='Support',exact=True).click()
    assert page.locator('#anatomy-source').inner_text() == 'test/fixtures/rows.json'
    page.get_by_role('button',name='Implementation',exact=True).click()
    assert page.locator('#anatomy-source').inner_text() == 'src/csv.ts'
    assert page.locator('#connect').get_attribute('aria-disabled')=='true'
    page.locator('#settings summary').click()
    assert page.locator('#settings').get_attribute('open') is not None
    print(json.dumps({'scope':'offline authored-source DOM render, no HTTP or backend','layouts':results,'pageErrors':errors,'anatomyTabs':'passed','privacyDisclosure':'passed','unavailableBackend':'correctly disabled'},indent=2))
    browser.close()
