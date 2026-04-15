import * as fs from 'fs';

export class Uri {
  fsPath: string;

  private constructor(fsPath: string) {
    this.fsPath = fsPath;
  }

  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }

  static parse(value: string): Uri {
    return new Uri(value);
  }
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(public start: Position, public end: Position) {}
}

export class WorkspaceEdit {
  readonly operations: Array<
    | { type: 'createFile'; uri: Uri }
    | { type: 'replace'; uri: Uri; text: string }
  > = [];

  createFile(uri: Uri): void {
    this.operations.push({ type: 'createFile', uri });
  }

  replace(uri: Uri, _range: Range, text: string): void {
    this.operations.push({ type: 'replace', uri, text });
  }
}

export const ViewColumn = {
  Beside: 2,
};

export const StatusBarAlignment = {
  Right: 2,
};

export class ThemeColor {
  constructor(public id: string) {}
}

export const window = {
  createOutputChannel: () => ({
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    backgroundColor: undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showTextDocument: async () => undefined,
  activeTextEditor: undefined,
};

export const workspace = {
  workspaceFolders: [{ uri: Uri.file('/workspace') }],
  isTrusted: true,
  getConfiguration: () => ({
    get: (_key: string, fallback?: unknown) => fallback,
    inspect: () => ({}),
  }),
  getWorkspaceFolder: () => ({ uri: Uri.file('/workspace') }),
  findFiles: async () => [],
  openTextDocument: async () => ({
    getText: () => '',
    positionAt: (offset: number) => new Position(0, offset),
    save: async () => true,
  }),
  applyEdit: async (edit: WorkspaceEdit) => {
    for (const op of edit.operations) {
      if (op.type === 'createFile') {
        fs.closeSync(fs.openSync(op.uri.fsPath, 'w'));
      } else {
        fs.writeFileSync(op.uri.fsPath, op.text, 'utf8');
      }
    }
    return true;
  },
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  fs: {
    readFile: async () => new Uint8Array(),
    writeFile: async (uri: Uri, content: Uint8Array) => {
      fs.writeFileSync(uri.fsPath, Buffer.from(content));
    },
  },
};

export const commands = {
  executeCommand: async () => undefined,
};

export const env = {
  remoteName: undefined,
  clipboard: {
    writeText: async () => undefined,
  },
  openExternal: async () => undefined,
};
