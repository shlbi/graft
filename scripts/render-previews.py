"""Render OFFLINE UI previews from a previously verified HTTP evidence report.

Requires Python, Playwright, Pillow, and Chromium. No live browser integration,
network proxying, or policy changes are performed by this script.
"""
from pathlib import Path
import argparse
import json
import re
import shutil

from PIL import Image
from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chromium", help="Path to an installed Chromium executable")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    evidence_path = root / "docs/verification/release-http-session.json"
    if not evidence_path.is_file():
        parser.error("Run npm run build and node scripts/capture-evidence.mjs first.")
    report = json.loads(evidence_path.read_text(encoding="utf-8"))
    html = (root / "ui/index.html").read_text(encoding="utf-8")
    css = "\n".join((root / "ui" / name).read_text(encoding="utf-8")
                    for name in ("styles.css", "upload.css"))
    html = re.sub(r'<link rel="stylesheet"[^>]*>', '', html)
    html = re.sub(r'<script[^>]*src="/app.js"[^>]*></script>', '', html)
    html = html.replace('</head>', '<style>' + css + '</style></head>')
    client = (root / "ui/app.js").read_text(encoding="utf-8")
    marker = "async function requestJson"
    if marker not in client:
        raise RuntimeError("Client structure changed; review the offline rendering boundary.")
    render_functions = client.split(marker, 1)[0]
    assets = root / "docs/assets"
    assets.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=args.chromium or shutil.which("chromium"), headless=True)
        try:
            context = browser.new_context(viewport={"width": 1280, "height": 980},
                                          device_scale_factor=1)
            context.route("**/*", lambda route: route.abort())
            page = context.new_page()
            page.set_content(html, wait_until="domcontentloaded")
            page.add_script_tag(content=render_functions)
            page.evaluate('(r) => renderReview(r)', report["review"])
            page.evaluate("""() => {
                document.querySelector('.scope-note').textContent =
                    'OFFLINE UI PREVIEW · REAL RECORDED FIXTURE DATA';
                document.querySelectorAll('button,input').forEach(x => x.disabled = true);
            }""")
            assert page.locator('#statusPill').inner_text() == 'READY FOR REVIEW'
            assert page.locator('#uploadPanel').is_hidden()
            assert page.locator('#resultPanel').is_hidden()
            assert page.locator('.node').count() == 7
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            page.screenshot(path=str(assets / 'review-preview.png'))
            page.locator('.diff-wrap').evaluate('(x) => x.open = true')
            page.locator('.diff-wrap').screenshot(path=str(assets / 'integration-preview.png'))
            page.evaluate('(r) => renderProof(r)', report['approval'])
            page.evaluate('(r) => renderJob(r)', report['completed'])
            page.evaluate("""() => {
                document.querySelector('#uploadPanel').hidden = false;
                document.querySelector('#uploadPanel h2').textContent =
                    'Recorded destination processing result';
                document.querySelector('#fileLabel').textContent =
                    'Offline preview · recorded HTTP request, not a live upload';
                document.querySelectorAll('button,input').forEach(x => x.disabled = true);
            }""")
            assert 'graft-proof.txt' in page.locator('#uploadResult').inner_text()
            assert str(report['completed']['size']) in page.locator('#uploadResult').inner_text()
            page.locator('#uploadPanel').screenshot(path=str(assets / 'processing-preview.png'))
            page.set_viewport_size({"width": 390, "height": 844})
            page.evaluate('window.scrollTo(0,0)')
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            page.screenshot(path=str(assets / 'mobile-preview.png'))
        finally:
            browser.close()
    for name, width, quality in [('review-preview', 900, 62),
                                  ('processing-preview', 1000, 58)]:
        with Image.open(assets / (name + '.png')) as image:
            resized = image.resize((width, round(image.height * width / image.width)),
                                   Image.Resampling.LANCZOS)
            resized.save(assets / (name + '.webp'), quality=quality, method=6)
    print('Offline rendering checks passed. These images are NOT live-browser evidence.')


if __name__ == '__main__':
    main()
