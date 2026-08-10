// Level 1's real inline ghost-text completion -- like GitHub Copilot/Cursor:
// type code, see the predicted continuation appear as grey text, Tab to
// accept. Registers a Monaco InlineCompletionsProvider that calls the Go
// engine's CodeIntelCompleteInline per keystroke (after a debounce) and
// shows whatever text comes back. Tab-to-accept and Esc/keep-typing-to-
// dismiss are Monaco's own built-in behavior once an item is returned --
// no custom keybinding code needed, the same public API VS Code's real
// Copilot extension uses.
import type * as monacoNS from "monaco-editor";
import * as wailsClient from "../wailsClient";

export interface InlineCompletionContextSource {
  enabled: boolean;
  root: string | null;
  path: string | null;
}

const DEBOUNCE_MS = 300;
const PREFIX_LINES = 100;
const SUFFIX_LINES = 20;

// Monaco assigns these language ids automatically from file extension --
// matches Editor.tsx's isCodeIntelPath (.ts/.tsx/.js/.jsx/.py).
const LANGUAGE_SELECTOR = ["typescript", "javascript", "typescriptreact", "javascriptreact", "python"];

// registerInlineCompletionsProvider is a global `languages` registration,
// not per-editor-instance -- guard so re-mounting the editor (e.g. a tab
// switch that remounts MonacoEditor) doesn't stack duplicate providers.
let registered = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Registers the ghost-text provider once. getContext is read fresh on every request, not captured, so it should read from refs. */
export function registerInlineCompletionProvider(
  monaco: typeof monacoNS,
  getContext: () => InlineCompletionContextSource,
): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerInlineCompletionsProvider(LANGUAGE_SELECTOR, {
    async provideInlineCompletions(model, position, _context, token) {
      const { enabled, root, path } = getContext();
      if (!enabled || !root || !path) return { items: [] };

      // Debounce: wait, then bail immediately if Monaco already cancelled
      // this request because the user kept typing -- the actual cost
      // control here, via Monaco's own cancellation contract.
      await sleep(DEBOUNCE_MS);
      if (token.isCancellationRequested) return { items: [] };

      const lineCount = model.getLineCount();
      const suffixEndLine = Math.min(lineCount, position.lineNumber + SUFFIX_LINES);
      const prefix = model.getValueInRange({
        startLineNumber: Math.max(1, position.lineNumber - PREFIX_LINES),
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const suffix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: suffixEndLine,
        endColumn: model.getLineMaxColumn(suffixEndLine),
      });

      let insertText: string;
      try {
        insertText = await wailsClient.codeIntelCompleteInline(root, path, prefix, suffix);
      } catch {
        return { items: [] };
      }
      if (token.isCancellationRequested || !insertText) return { items: [] };

      return {
        items: [{ insertText, range: monaco.Range.fromPositions(position, position) }],
        // Keep showing this suggestion (just shrinking as matching characters
        // are typed) instead of vanishing the moment a keystroke lands and a
        // new request goes out -- Monaco only drops it once the user types
        // something that no longer matches, or a new completion actually
        // arrives to replace it.
        enableForwardStability: true,
      };
    },
    disposeInlineCompletions() {
      // No per-completion resources are held onto -- insertText is a plain string.
    },
  });
}
