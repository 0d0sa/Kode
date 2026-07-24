import type { Permissions } from '../config/schema.js';
import { JsonlAuditSink } from '../permission/audit.js';
import { applyPatchTool } from './edit/apply-patch.js';
import { replaceInFileTool } from './edit/replace.js';
import { globTool } from './fs/glob.js';
import { grepTool } from './fs/grep.js';
import { readFileTool } from './fs/read.js';
import { writeFileTool } from './fs/write.js';
import { ToolRegistry } from './registry.js';
import { runCommandTool } from './shell/run.js';

export function createDefaultRegistry(permissions: Permissions = {}): ToolRegistry {
  const r = new ToolRegistry(permissions, { audit: new JsonlAuditSink() });
  r.register(readFileTool);
  r.register(globTool);
  r.register(grepTool);
  r.register(writeFileTool);
  r.register(replaceInFileTool);
  r.register(applyPatchTool);
  r.register(runCommandTool);
  return r;
}

export { ToolRegistry } from './registry.js';
export type * from './types.js';
