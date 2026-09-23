import { snapshot, analyze, reviewProposal } from './core.mjs';
// Authored, deterministic fixtures. This is not an AI response and never pretends to use real repositories.
const csv = `export function toCSV(rows) {\n  const cell = value => {\n    let text = String(value ?? '');\n    if (/^[=+@\\-\\t\\r]/.test(text)) text = "'" + text;\n    return '"' + text.replaceAll('"', '""') + '"';\n  };\n  return rows.map(row => row.map(cell).join(',')).join('\\r\\n') + '\\r\\n';\n}\n`;
const sourceApp = `import { toCSV } from './csv.mjs';\nexport const exportReport = rows => toCSV([['Task', 'Status'], ...rows.map(r => [r.title, r.done ? 'Done' : 'Open'])]);\n`;
const before = `export function taskCount(tasks) {\n  return tasks.length;\n}\n`;
const after = `import { toCSV } from './csv.mjs';\n\nexport function taskCount(tasks) {\n  return tasks.length;\n}\n\nexport function exportTasks(tasks) {\n  return toCSV([['Task', 'Status'], ...tasks.map(task => [task.name, task.complete ? 'Done' : 'Open'])]);\n}\n`;
export const demoInput = {
  source: { name: 'sample/report-studio', files: [{ path: 'src/csv.mjs', content: csv }, { path: 'src/app.mjs', content: sourceApp }, { path: 'README.md', content: 'Original synthetic CSV export sample authored for Graft. Not a third-party repository.\n' }] },
  destination: { name: 'sample/taskboard', files: [{ path: 'src/app.mjs', content: before }, { path: 'README.md', content: 'Original synthetic task board sample. Tasks use name and complete.\n' }] }
};
export const demoProposal = { summary: 'Move CSV export into the task board, adapting title/done to name/complete and preserving taskCount.',
  changes: [
    { path: 'src/csv.mjs', action: 'add', content: csv, reason: 'Reuse the CSV serializer, including quoting and common spreadsheet-formula prefix protection.', sourcePaths: ['src/csv.mjs'] },
    { path: 'src/app.mjs', action: 'update', content: after, reason: 'Expose exportTasks using the destination task schema; keep existing taskCount behavior.', sourcePaths: ['src/app.mjs', 'src/csv.mjs'] }
  ],
  risks: ['This synthetic example exports a string, not a wired browser download button.', 'Spreadsheet handling varies by application; review the supported input policy for your use case.'],
  suggestedChecks: ['Verify taskCount still returns the original result.', 'Test CSV commas, quotes, newlines, empty values, and formula-like cells.', 'Verify the destination task schema and wire the intended UI separately.']
};
export function demoRun() {
  const source = snapshot(demoInput.source), destination = snapshot(demoInput.destination);
  const analysis = analyze(source, destination, 'CSV export');
  const review = reviewProposal(demoProposal, source, destination, analysis.context, 'authored-demo');
  const { context, ...publicAnalysis } = analysis;
  return { mode: 'synthetic-demo', analysis: publicAnalysis, review };
}
