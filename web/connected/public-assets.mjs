// Shared, explicit allowlist for Vercel's static build and the connected server.
// Never serve/copy an entire directory: it may contain operator secrets or data.
export const PUBLIC_ASSETS = Object.freeze([
  { route: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { route: '/app.mjs', file: 'app.mjs', type: 'text/javascript; charset=utf-8' },
  { route: '/style.css', file: 'style.css', type: 'text/css; charset=utf-8' },
  { route: '/brand.css', file: 'brand.css', type: 'text/css; charset=utf-8' },
  { route: '/mcp/', file: 'mcp/index.html', type: 'text/html; charset=utf-8' },
  { route: '/mcp/mcp.css', file: 'mcp/mcp.css', type: 'text/css; charset=utf-8' },\n  { route: '/mcp/mcp-page.js', file: 'mcp/mcp-page.js', type: 'text/javascript; charset=utf-8' },
  { route: '/assets/repot-mark-c7217cca.png', file: 'assets/repot-mark-c7217cca.png', type: 'image/png' },
  { route: '/assets/repot-favicon-c7217cca.png', file: 'assets/repot-favicon-c7217cca.png', type: 'image/png' }
].map(asset => Object.freeze(asset)));
export const staticFiles = new Map(PUBLIC_ASSETS.map(({ route, file, type }) => [route, [file, type]]));
