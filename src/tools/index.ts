import type { Permissions } from '../config/schema.js';
import { replaceInFileTool } from './edit/replace.js';
import { readFileTool } from './fs/read.js';
import { ToolRegistry } from './registry.js';
import { runCommandTool } from './shell/run.js';

export function createDefaultRegistry(permissions: Permissions = {}): ToolRegistry {
  const r = new ToolRegistry(permissions);
  r.register(readFileTool);
  r.register(replaceInFileTool);
  r.register(runCommandTool);
  return r;
}

export { ToolRegistry } from './registry.js';
export type * from './types.js';
