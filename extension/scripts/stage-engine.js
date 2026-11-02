const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const sourceRoot = path.join(repositoryRoot, 'engine', 'src');
const targetRoot = path.join(extensionRoot, 'engine', 'src');

fs.rmSync(path.join(extensionRoot, 'engine'), { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });

function copyDirectory(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) {
      continue;
    }
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true });
      copyDirectory(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

copyDirectory(sourceRoot, targetRoot);
