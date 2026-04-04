import type { ReactNode } from "react";

interface SidebarProps {
  tabs: { label: string; path: string }[];
  activeTab: string;
  onTabChange: (path: string) => void;
  action?: ReactNode;
  liveRun?: { title: string; onClick: () => void } | null;
  children: ReactNode;
}

export function Sidebar({ tabs, activeTab, onTabChange, action, liveRun, children }: SidebarProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="top-tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.path}
            className={activeTab === tab.path ? "active" : ""}
            onClick={() => onTabChange(tab.path)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {liveRun && (
        <button
          className="flex items-center gap-2 w-full px-3 py-2 bg-teal-wash border-b border-edge text-left text-sm hover:bg-teal-100 transition-colors"
          onClick={liveRun.onClick}
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-teal" />
          </span>
          <span className="text-teal-dark font-medium truncate">Running: {liveRun.title}</span>
        </button>
      )}
      {action && (
        <div className="p-3 border-b border-edge">
          {action}
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}
