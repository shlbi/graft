/** Bounded local processes for authored fixtures; not a sandbox for uploaded repositories. */
import { spawn } from 'node:child_process';
export function runProcess(executable, args, cwd, { timeout = 30000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '', HOME: cwd, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' };
    const grouped = process.platform !== 'win32';
    const child = spawn(executable, args, { cwd, env, detached: grouped, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure = null;
    const stop = message => {
      failure ??= new Error(message);
      try { if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => stop(`Process exceeded ${timeout} ms.`), timeout);
    const append = (data, isError) => {
      bytes += data.length;
      if (bytes > maxBytes) { stop('Process output limit exceeded.'); return; }
      if (isError) stderr += data.toString('utf8'); else stdout += data.toString('utf8');
    };
    child.stdout.on('data', data => append(data, false)); child.stderr.on('data', data => append(data, true));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // Terminate remaining fixture workers in this process group. This is not a security sandbox.
      if (grouped && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* no remaining process group */ } }
      if (failure) reject(failure);
      else if (signal) reject(new Error(`Process terminated by ${signal}.`));
      else resolve({ exitCode: code, stdout, stderr });
    });
  });
}
