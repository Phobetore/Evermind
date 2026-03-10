"use client";

import ConversationList from "@/components/chat/ConversationList";

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Conversation sidebar */}
      <aside className="hidden h-full w-56 shrink-0 overflow-auto border-r border-border bg-sidebar/80 md:block">
        <ConversationList />
      </aside>
      {/* Chat content */}
      <div className="flex-1 min-w-0 h-full overflow-hidden">{children}</div>
    </div>
  );
}
