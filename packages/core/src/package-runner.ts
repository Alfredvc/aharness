export type { RunPackagedFsmCliOptions } from './fsmPackage/runner.js';
import { runPackagedFsmCliForTest, type RunPackagedFsmCliOptions } from './fsmPackage/runner.js';

export function runPackagedFsmCli(options: RunPackagedFsmCliOptions): Promise<number> {
  return runPackagedFsmCliForTest(options);
}
