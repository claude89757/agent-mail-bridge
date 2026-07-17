#!/usr/bin/env node
/**
 * CLI entry point (`agent-mail-bridge` / `amb`).
 *
 * Phase 0 placeholder: prints an identification line until the real
 * command surface (setup / doctor / status / pause / resume) lands.
 */
import { pathToFileURL } from 'node:url';

import { PACKAGE_NAME } from '../index.js';

export function buildCliGreeting(): string {
  return `${PACKAGE_NAME}: commands are not implemented yet (Phase 0 skeleton).`;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  console.log(buildCliGreeting());
}
