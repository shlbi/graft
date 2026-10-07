/** Public shell with one server-authored pricing navigation link. No payment state comes from this page. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function GET() {
  const html = await readFile(resolve(process.cwd(),'public/index.html'),'utf8');
  return new Response(html.replace('<nav aria-label="Main navigation">', '<nav aria-label="Main navigation"><a href="/pricing">Pricing</a>'), {
    headers: {'content-type':'text/html; charset=utf-8','cache-control':'public, max-age=300'}
  });
}
