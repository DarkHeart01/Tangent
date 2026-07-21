import { useEffect, type ReactNode } from "react";

export type ContextMenuItem = {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
  icon?: ReactNode;
};

export default function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    document.addEventListener("pointerdown", close);
    document.addEventListener("contextmenu", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("contextmenu", close); };
  }, [onClose]);
  return <div className="context-menu" style={{ left: x, top: y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
    {items.map((item, index) => item.separator ? <div className="context-menu__separator" key={`separator-${index}`} /> : <button key={`${item.label}-${index}`} disabled={item.disabled} onClick={() => { item.onClick?.(); onClose(); }}>
      <span>{item.icon}{item.label}</span><kbd>{item.shortcut}</kbd>
    </button>)}
  </div>;
}
