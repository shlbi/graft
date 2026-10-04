/**
 * @file Shared browser/server intake policy for bounded source and project metadata.
 * Text eligibility is not language/runtime support. Signing material, credentials,
 * generated output and dependency caches stay excluded even inside mobile projects.
 */
export const LIMITS = Object.freeze({ fileBytes: 60000, snapshotBytes: 750000, files: 1500, contextBytes: 110000, changes: 10 });
const ignored = /^(?:\.git|\.github|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|node_modules|vendor|dist|build|target|coverage|\.next|\.venv|venv|__pycache__|\.DS_Store|\.dart_tool|\.gradle|Pods|DerivedData|\.idea)$/i;
const source = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|cs|fs|fsx|c|cc|cpp|h|hpp|m|mm|php|dart|vue|svelte|css|scss|html|sql|json|ya?ml|toml|md|txt|gradle|xml|plist|xcconfig|pbxproj|storyboard|xib|entitlements|csproj|fsproj|props|targets|proto|graphql|gql|lua|r|jl|ex|exs|erl|hrl|hs|lhs|scala|sc|clj|cljs|cljc|edn|elm|pl|pm|sh|bash|zsh|cmake)$/i;
const privateConfig = /(?:^|\/)(?:local\.properties|key\.properties|keystore\.properties|google-services\.json|GoogleService-Info\.plist|\.Renviron|\.Rhistory)$/i;
/** Validate a portable relative path; traversal, case-unsafe device names and control characters are rejected. */
export function pathShape(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 240 &&
    /^[A-Za-z0-9_@()[\].,+/-]+$/.test(path) &&
    path.split('/').every(p => p && p !== '.' && p !== '..' && !p.endsWith('.') &&
      !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p));
}
/** Admit source/project text, never signing keys, dependency caches or known private platform configuration. */
export function eligiblePath(path) {
  return pathShape(path) && !path.split('/').some(p => ignored.test(p)) && !privateConfig.test(path) &&
    !/(?:\.min\.[cm]?js|\.d\.ts|\.lock|package-lock\.json|pnpm-lock\.yaml)$/i.test(path) &&
    (source.test(path) || /(?:^|\/)(?:LICENSE(?:-[\w-]+)?|NOTICE|Dockerfile|Makefile|CMakeLists\.txt|Gemfile|Podfile|go\.mod)$/i.test(path));
}
/** Conservative secret heuristic, not a substitute for a dedicated secret scanner. */
export function looksSensitive(text) {
  return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})/.test(text) ||
    /(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_+/=-]{24,}["']/i.test(text);
}
