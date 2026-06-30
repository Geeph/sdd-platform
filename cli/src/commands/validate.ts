import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import type { SDDProjects } from '@sdd/schemas';
import {
  validateImpactDocument,
  validateProjectsDocument,
  validateTaskDocument,
} from '@sdd/schemas';
import { parse as parseYaml } from 'yaml';
import { semanticValidateProjects } from '../semantics.js';

export default class Validate extends Command {
  static override description = 'Validate SDD schema documents';

  static override examples = [
    '<%= config.bin %> validate',
    '<%= config.bin %> validate --repo ./demo-product',
    '<%= config.bin %> validate --kind task task.yaml',
    '<%= config.bin %> validate --kind impact impact.json',
  ];

  static override flags = {
    repo: Flags.string({
      description: 'Repository root directory (default: current directory)',
      default: '.',
    }),
    kind: Flags.string({
      description: 'Document kind to validate (task or impact)',
      options: ['task', 'impact'],
    }),
  };

  static override args = {
    file: Args.string({
      description: 'File to validate (required with --kind)',
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { flags, args } = await this.parse(Validate);

    try {
      if (flags.kind) {
        if (!args.file) {
          this.error('A file path is required when using --kind', {
            exit: 2,
          });
        }
        await this.validateKind(flags.kind, args.file);
      } else {
        await this.validateProjects(flags.repo);
      }
    } catch (err) {
      if (err instanceof ValidationFailed) {
        for (const msg of err.messages) {
          this.error(msg, { exit: false });
        }
        this.exit(1);
      }
      throw err;
    }
  }

  private async validateKind(kind: string, file: string): Promise<void> {
    const data = await this.loadYaml(file);
    const validator = kind === 'task' ? validateTaskDocument : validateImpactDocument;
    const result = await validator(data);
    if (!result.ok) {
      const messages = result.errors.map(
        (e: { path: string; message: string; keyword: string }) =>
          `${file}${e.path}: ${e.message} (${e.keyword})`,
      );
      throw new ValidationFailed(messages);
    }
    this.log(`${file}: ok`);
  }

  private async validateProjects(repo: string): Promise<void> {
    const filePath = join(resolve(repo), 'projects.yaml');
    const data = await this.loadYaml(filePath);
    const result = await validateProjectsDocument(data);
    if (!result.ok) {
      const messages = result.errors.map(
        (e: { path: string; message: string; keyword: string }) =>
          `${filePath}${e.path}: ${e.message} (${e.keyword})`,
      );
      throw new ValidationFailed(messages);
    }

    const semanticErrors = semanticValidateProjects(data as SDDProjects);
    if (semanticErrors.length > 0) {
      throw new ValidationFailed(semanticErrors);
    }
    this.log(`${filePath}: ok`);
  }

  private async loadYaml(file: string): Promise<unknown> {
    const content = await readFile(file, 'utf8');
    return parseYaml(content);
  }
}

class ValidationFailed extends Error {
  messages: string[];
  constructor(messages: string[]) {
    super(`Validation failed with ${messages.length} error(s)`);
    this.messages = messages;
  }
}
