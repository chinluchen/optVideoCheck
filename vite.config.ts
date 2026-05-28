import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const packageJsonPath = path.resolve(__dirname, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const packageVersion = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  const buildStamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  let shortCommit = '';
  try {
    shortCommit = execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    shortCommit = '';
  }

  const autoVersion = `v${packageVersion}-${shortCommit || buildStamp}`;
  const resolvedAppVersion = (env.VITE_APP_VERSION || autoVersion).replace(/-local$/, '');

  return {
    base: '/',
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(resolvedAppVersion),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
