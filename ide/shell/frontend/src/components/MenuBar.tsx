import { useState, type ReactNode } from "react";
import { useWorkspace } from "../lib/WorkspaceContext";

type MenuBarProps = {
  onTerminal: () => void;
  onResetLayout: () => void;
  onNewSession: () => void;
};

export default function MenuBar({ onTerminal, onResetLayout, onNewSession }: MenuBarProps) {
  const { openFile, openFolder, createFile, closeWorkspace } = useWorkspace();
  const [open, setOpen] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => { setOpen(null); try { await action(); } catch (error) { window.alert(String(error)); } };
  const item = (name: string, menu: ReactNode) => <div className="menu-bar__item-wrap"><button className={`menu-bar__item ${open === name ? "is-open" : ""}`} onClick={() => setOpen((current) => current === name ? null : name)}>{name}</button>{open === name && <div className="menu-dropdown">{menu}</div>}</div>;
  return <nav className="menu-bar" aria-label="Application menu">
    {item("File", <><button onClick={() => { setOpen(null); createFile(); }}>New File <kbd>Ctrl+N</kbd></button><button onClick={() => run(openFile)}>Open File… <kbd>Ctrl+O</kbd></button><button onClick={() => run(openFolder)}>Open Folder… <kbd>Ctrl+K Ctrl+O</kbd></button><hr /><button onClick={() => { setOpen(null); closeWorkspace(); }}>Close Folder</button></>)}
    {item("Edit", <><button onClick={() => document.execCommand("undo")}>Undo <kbd>Ctrl+Z</kbd></button><button onClick={() => document.execCommand("redo")}>Redo <kbd>Ctrl+Y</kbd></button></>)}
    {item("Selection", <><button onClick={() => document.execCommand("selectAll")}>Select All <kbd>Ctrl+A</kbd></button></>)}
    {item("View", <><button onClick={() => { setOpen(null); onTerminal(); }}>Focus Terminal</button><button onClick={() => { setOpen(null); onResetLayout(); }}>Reset Layout</button></>)}
    {item("Go", <><button onClick={() => setOpen(null)}>Back</button><button onClick={() => setOpen(null)}>Forward</button></>)}
    {item("Run", <><button onClick={() => { setOpen(null); onNewSession(); }}>Start Session from Agent Swarm</button></>)}
    {item("Terminal", <><button onClick={() => { setOpen(null); onTerminal(); }}>New Terminal</button></>)}
    {item("Help", <><button onClick={() => window.alert("Tangent IDE — agent-assisted development workspace")}>About Tangent IDE</button></>)}
  </nav>;
}
