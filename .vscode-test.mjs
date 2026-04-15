import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceFolder = join(__dirname, '.vscode-test', 'e2e-workspace');
const userDataDir = join(__dirname, '.vscode-test', 'e2e-user-data');
mkdirSync(workspaceFolder, { recursive: true });
rmSync(userDataDir, { recursive: true, force: true });
mkdirSync(userDataDir, { recursive: true });

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	launchArgs: [
		`--user-data-dir=${userDataDir}`,
		'--skip-welcome',
		'--skip-release-notes',
	],
});
