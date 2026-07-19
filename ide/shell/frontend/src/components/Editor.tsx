import "../lib/monacoSetup";
import { useCallback, useEffect, useRef, useState } from "react";
import MonacoEditor from "@monaco-editor/react";
import { useSession } from "../lib/SessionContext";
import { onEnvelopeType } from "../lib/wsClient";
import * as wailsClient from "../lib/wailsClient";
import type { FileNode } from "../lib/wailsClient";

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "css":
      return "css";
    case "html":
      return "html";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}

function FileTreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (node.is_dir) {
    return (
      <div>
        <div className="file-tree__row file-tree__row--dir" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen((o) => !o)}>
          <span className="file-tree__chevron">{open ? "▾" : "▸"}</span>
          {node.name}
        </div>
        {open && node.children?.map((child) => (
          <FileTreeNode key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
        ))}
      </div>
    );
  }
  return (
    <div
      className={`file-tree__row ${node.path === selectedPath ? "is-selected" : ""}`}
      style={{ paddingLeft: depth * 14 + 14 }}
      onClick={() => onSelect(node.path)}
    >
      {node.name}
    </div>
  );
}

export default function Editor() {
  const { activeSessionId, activeWsClient } = useSession();
  const [tree, setTree] = useState<FileNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const writeTimer = useRef<number | null>(null);

  const refreshTree = useCallback(async (sessionId: string) => {
    try {
      const nodes = await wailsClient.getWorkspaceTree(sessionId);
      setTree(nodes);
    } catch {
      setTree([]);
    }
  }, []);

  useEffect(() => {
    setSelectedPath(null);
    setContent("");
    setDirty(false);
    if (!activeSessionId) {
      setTree([]);
      return;
    }
    refreshTree(activeSessionId);
  }, [activeSessionId, refreshTree]);

  useEffect(() => {
    if (!activeWsClient || !activeSessionId) return;
    return onEnvelopeType(activeWsClient, "file.changed", () => {
      refreshTree(activeSessionId);
    });
  }, [activeWsClient, activeSessionId, refreshTree]);

  const handleSelect = useCallback(
    async (path: string) => {
      if (!activeSessionId) return;
      const file = await wailsClient.readFile(activeSessionId, path);
      setSelectedPath(path);
      setContent(file.content);
      setDirty(false);
    },
    [activeSessionId],
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!activeSessionId || !selectedPath) return;
      const next = value ?? "";
      setContent(next);
      setDirty(true);
      if (writeTimer.current) window.clearTimeout(writeTimer.current);
      writeTimer.current = window.setTimeout(async () => {
        setSaving(true);
        try {
          await wailsClient.writeFile(activeSessionId, selectedPath, next);
          setDirty(false);
        } finally {
          setSaving(false);
        }
      }, 500);
    },
    [activeSessionId, selectedPath],
  );

  if (!activeSessionId) {
    return <div className="editor-panel editor-panel--empty">Select or start a session to browse its worktree.</div>;
  }

  return (
    <div className="editor-panel">
      <div className="editor-panel__tree">
        {tree.length === 0 && <div className="file-tree__empty">worktree is empty</div>}
        {tree.map((node) => (
          <FileTreeNode key={node.path} node={node} depth={0} selectedPath={selectedPath} onSelect={handleSelect} />
        ))}
      </div>
      <div className="editor-panel__editor">
        {selectedPath ? (
          <>
            <div className="editor-panel__filebar">
              <span>{selectedPath}</span>
              <span className="editor-panel__status">{saving ? "Saving…" : dirty ? "Unsaved" : "Saved"}</span>
            </div>
            <MonacoEditor
              height="100%"
              language={languageFor(selectedPath)}
              value={content}
              theme="vs-dark"
              onChange={handleChange}
              options={{ minimap: { enabled: false }, fontSize: 13 }}
            />
          </>
        ) : (
          <div className="editor-panel__placeholder">Select a file</div>
        )}
      </div>
    </div>
  );
}
