import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const generatedDir = join(packageRoot, 'generated');

async function main() {
  await mkdir(generatedDir, { recursive: true });
  const schemaFiles = (await readdir(packageRoot)).filter((f) => f.endsWith('.schema.json'));
  const outputs = [];
  for (const file of schemaFiles.sort()) {
    const schemaPath = join(packageRoot, file);
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    const name = file.replace('.schema.json', '');
    const ts = await compile(schema, name, {
      unknownAny: false,
      bannerComment: `// Generated from ${file}. Do not edit by hand.`,
      style: {
        semi: true,
        singleQuote: true,
        trailingComma: 'all',
      },
    });
    outputs.push(ts);
  }
  await writeFile(join(generatedDir, 'types.d.ts'), outputs.join('\n'));
  console.log(`Generated types for: ${schemaFiles.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
