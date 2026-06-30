#!/usr/bin/env node

// Suppress oclif's internal warnings during command discovery.
// oclif probes several candidate command paths and emits warnings via
// console.error when some fail, even though the fallback path succeeds.
// These pollute stderr and break tests that assert on stderr. Filter out only
// these expected warnings.
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  const msg = args.map((a) => String(a)).join(' ');
  if (
    msg.includes('SINGLE_COMMAND_CLI') ||
    msg.includes('Could not find source for') ||
    msg.includes('Defaulting to compiled source')
  ) {
    return;
  }
  originalConsoleError(...args);
};

// Also filter Node.js 'warning' events for oclif-related MODULE_NOT_FOUND.
const originalEmit = process.emit.bind(process);
process.emit = (event, warning, ...rest) => {
  if (event === 'warning' && warning && typeof warning === 'object') {
    const code = warning.code ?? '';
    const name = warning.name ?? '';
    const msg = warning.message ?? '';
    if (
      code === 'MODULE_NOT_FOUND' ||
      name === 'ModuleLoadError' ||
      msg.includes('SINGLE_COMMAND_CLI') ||
      msg.includes('@oclif/core')
    ) {
      return false;
    }
  }
  return originalEmit(event, warning, ...rest);
};

import { execute } from '@oclif/core';

await execute({ dir: import.meta.url });
