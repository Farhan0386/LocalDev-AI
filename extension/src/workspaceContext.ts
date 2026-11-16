import * as vscode from 'vscode';
import * as path from 'node:path';

export interface ActiveEditorContext {
  path: string;
  language: string;
  content: string;
  lineRange?: string;
  totalLines: number;
  isSelection: boolean;
}

export interface ReferencedFile {
  path: string;
  content: string;
  lineRange?: string;
}

export interface WorkspaceContextData {
  active_file?: ActiveEditorContext;
  referenced_files: ReferencedFile[];
  directory_tree?: string;
}

const DEFAULT_EXCLUDE_GLOB = '{**/.git/**,**/node_modules/**,**/.venv/**,**/__pycache__/**,**/out/**,**/dist/**,**/.vscode/**,**/.idea/**,**/*.pyc,**/*.vsix}';
const MAX_FILE_LINES = 150;
const MAX_FILE_CHARS = 4000;

/**
 * Collects context from the currently active text editor in VS Code.
 */
export function getActiveEditorContext(): ActiveEditorContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document) {
    return undefined;
  }

  const document = editor.document;
  // Ignore virtual or internal documents
  if (document.uri.scheme !== 'file') {
    return undefined;
  }

  const relativePath = vscode.workspace.asRelativePath(document.uri);
  const totalLines = document.lineCount;

  if (!editor.selection.isEmpty) {
    const selectedText = document.getText(editor.selection);
    const startLine = editor.selection.start.line + 1;
    const endLine = editor.selection.end.line + 1;
    return {
      path: relativePath,
      language: document.languageId,
      content: truncateText(selectedText, MAX_FILE_LINES, MAX_FILE_CHARS),
      lineRange: `${startLine}-${endLine}`,
      totalLines,
      isSelection: true,
    };
  }

  // If no selection, grab the top snippet up to MAX_FILE_LINES
  const sampleLines = Math.min(totalLines, 80);
  const sampleRange = new vscode.Range(0, 0, sampleLines - 1, document.lineAt(sampleLines - 1).text.length);
  const text = document.getText(sampleRange);

  return {
    path: relativePath,
    language: document.languageId,
    content: truncateText(text, MAX_FILE_LINES, MAX_FILE_CHARS),
    lineRange: `1-${sampleLines}`,
    totalLines,
    isSelection: false,
  };
}

/**
 * Builds a lightweight directory outline of the workspace.
 */
export async function collectDirectoryTree(maxFiles = 60): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return '';
  }

  try {
    const files = await vscode.workspace.findFiles('**/*', DEFAULT_EXCLUDE_GLOB, maxFiles);
    if (files.length === 0) {
      return '';
    }

    const relativePaths = files.map((file) => vscode.workspace.asRelativePath(file)).sort();
    return relativePaths.join('\n');
  } catch {
    return '';
  }
}

/**
 * Scans prompt text for @filename mentions and retrieves their content.
 */
export async function collectReferencedFiles(
  prompt: string,
  explicitPaths: string[] = [],
): Promise<ReferencedFile[]> {
  const results: ReferencedFile[] = [];
  const mentioned = new Set<string>(explicitPaths);

  // Match @filename patterns like @src/index.ts or @app.py
  const regex = /@([a-zA-Z0-9_\-./\\]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    const target = match[1].trim();
    if (target && target !== 'workspace' && target !== 'file') {
      mentioned.add(target);
    }
  }

  for (const name of mentioned) {
    try {
      const found = await vscode.workspace.findFiles(`**/${name}`, DEFAULT_EXCLUDE_GLOB, 1);
      if (found.length === 0) {
        // Try searching by exact name or substring
        const fallback = await vscode.workspace.findFiles(`*${name}*`, DEFAULT_EXCLUDE_GLOB, 1);
        if (fallback.length > 0) {
          found.push(fallback[0]);
        }
      }

      if (found.length > 0) {
        const uri = found[0];
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf-8');
        results.push({
          path: vscode.workspace.asRelativePath(uri),
          content: truncateText(content, MAX_FILE_LINES, MAX_FILE_CHARS),
        });
      }
    } catch {
      // Ignore unreadable or missing files
    }
  }

  return results;
}

/**
 * Suggests workspace files for @file completion in the UI.
 */
export async function searchWorkspaceFiles(query: string, maxResults = 8): Promise<string[]> {
  try {
    const searchPattern = query.trim() ? `**/*${query.trim()}*` : '**/*';
    const matches = await vscode.workspace.findFiles(searchPattern, DEFAULT_EXCLUDE_GLOB, maxResults);
    return matches.map((uri) => vscode.workspace.asRelativePath(uri));
  } catch {
    return [];
  }
}

/**
 * Assembles full workspace context data for chat inference.
 */
export async function buildWorkspaceContext(
  prompt: string,
  options: {
    includeWorkspaceTree?: boolean;
    explicitFilePaths?: string[];
    includeActiveEditor?: boolean;
  } = {},
): Promise<WorkspaceContextData> {
  const context: WorkspaceContextData = {
    referenced_files: [],
  };

  if (options.includeActiveEditor !== false) {
    context.active_file = getActiveEditorContext();
  }

  if (options.includeWorkspaceTree) {
    context.directory_tree = await collectDirectoryTree();
  }

  context.referenced_files = await collectReferencedFiles(prompt, options.explicitFilePaths || []);

  return context;
}

function truncateText(text: string, maxLines: number, maxChars: number): string {
  const lines = text.split(/\r?\n/);
  let truncated = lines.slice(0, maxLines).join('\n');
  if (truncated.length > maxChars) {
    truncated = truncated.slice(0, maxChars) + '\n... [content truncated]';
  } else if (lines.length > maxLines) {
    truncated += '\n... [lines truncated]';
  }
  return truncated;
}
