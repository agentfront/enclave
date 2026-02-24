import { execSync } from 'node:child_process';
import path from 'node:path';

export default function globalSetup() {
  const bundleScript = path.resolve(__dirname, 'build-test-bundle.mjs');
  execSync(`node ${bundleScript}`, {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });
}
