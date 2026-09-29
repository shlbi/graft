/**
 * @file Repot web-engine module for policy. It supports bounded transfer analysis, provider integration, syntax adaptation, or test preservation used by the web and MCP products.
 *
 * Boundary note: keep repository context bounded and never claim execution/verification that this module did not actually perform.
 */
// Shared by browser intake and server validation. Filters are conservative, not a secret-scanning guarantee.
export const LIMITS = Object.freeze({ fileBytes: 60000, snapshotBytes: 750000, files: 1500, contextBytes: 110000, changes: 10 });
const ignored = /^(?:\.git|\.github|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|node_modules|vendor|dist|build|target|coverage|\.next|\.venv|venv|__pycache__|\.DS_Store)$/i;
const source = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|cs|c|cc|cpp|h|hpp|php|vue|svelte|css|scss|html|sql|json|ya?ml|toml|md|txt)$/i;
/**
 * @function pathShape
 * Implements path shape for Repot's bounded web transfer pipeline. Preserve bounded inputs, explicit uncertainty, and fail-closed behavior.
 */
export function pathShape(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 240 &&
    /^[A-Za-z0-9_@()[\].,+/-]+$/.test(path) &&
    path.split('/').every(p => p && p !== '.' && p !== '..' && !p.endsWith('.') &&
      !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p));
}
/**
 * @function eligiblePath
 * Implements eligible path for Repot's bounded web transfer pipeline. Preserve bounded inputs, explicit uncertainty, and fail-closed behavior.
 */
export function eligiblePath(path) {
  return pathShape(path) && !path.split('/').some(p => ignored.test(p)) &&
    !/(?:\.min\.[cm]?js|\.d\.ts|\.lock|package-lock\.json|pnpm-lock\.yaml)$/i.test(path) &&
    (source.test(path) || /(?:^|\/)(?:LICENSE(?:-[\w-]+)?|NOTICE|Dockerfile|Makefile|Gemfile|go\.mod)$/i.test(path));
}
/**
 * @function looksSensitive
 * Implements looks sensitive for Repot's bounded web transfer pipeline. Preserve bounded inputs, explicit uncertainty, and fail-closed behavior.
 */
export function looksSensitive(text) {
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})/.test(text) ||
    /(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_+/=-]{24,}["']/i.test(text);
}
