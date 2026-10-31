/**
 * Development: the collector (API + live stream) plus Vite's dev server with hot reload for the UI.
 * Open http://localhost:5173; Vite proxies /api and /ws to the collector.
 */
import { spawn } from 'node:child_process';

const port = process.env.BE_PORT ?? '47821';
const env = { ...process.env, BE_PORT: port, BE_DEV_ORIGIN: 'http://localhost:5173', FORCE_COLOR: '1' };
const opts = { stdio: 'inherit' as const, env, shell: process.platform === 'win32' };

const collector = spawn('pnpm', ['exec', 'tsx', 'watch', 'src/cli.ts', '--port', port], opts);
const vite = spawn('pnpm', ['exec', 'vite', '--config', 'web/vite.config.ts', '--open'], opts);

const stop = () => { collector.kill(); vite.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
collector.on('exit', code => { if (code) stop(); });
vite.on('exit', stop);
