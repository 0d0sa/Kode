import type { Permissions } from '../config/schema.js';
import type { CodebaseService } from '../codebase/service.js';
import { JsonlAuditSink } from '../permission/audit.js';
import { createCodebaseTools } from './codebase/index.js';
import { applyPatchTool } from './edit/apply-patch.js';
import { replaceInFileTool } from './edit/replace.js';
import { globTool } from './fs/glob.js';
import { grepTool } from './fs/grep.js';
import { readFileTool } from './fs/read.js';
import { writeFileTool } from './fs/write.js';
import { ToolRegistry } from './registry.js';
import { runCommandTool } from './shell/run.js';

export function createDefaultRegistry(
  permissions: Permissions = {},
  options: { codebase?: CodebaseService } = {},
): ToolRegistry {
  const r = new ToolRegistry(permissions, { audit: new JsonlAuditSink() });
  r.register(readFileTool);
  r.register(globTool);
  r.register(grepTool);
  r.register(writeFileTool);
  r.register(replaceInFileTool);
  r.register(applyPatchTool);
  r.register(runCommandTool);
  if (options.codebase) {
    for (const tool of createCodebaseTools(options.codebase)) r.register(tool);
  }
  return r;
}

export { ToolRegistry } from './registry.js';
export type * from './types.js';
