// Writes ../AgentOfficeRemote/addons/addons.yml (an XcodeGen include) listing every xcframework bare-link produced,
// so project.yml links and embeds the native addons without naming their versions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'AgentOfficeRemote', 'addons');
const frameworks = fs.readdirSync(dir).filter((f) => f.endsWith('.xcframework')).sort();
const yml = ['targets:', '  AgentOfficeRemote:', '    dependencies:', ...frameworks.map((f) => `      - framework: ${f}\n        embed: true`)].join('\n') + '\n';
fs.writeFileSync(path.join(dir, 'addons.yml'), yml);
console.log(`addons.yml: ${frameworks.length} frameworks`);
