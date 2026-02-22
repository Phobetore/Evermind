"use client";

import ConversationList from "@/components/chat/ConversationList";

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full">
      {/* Conversation sidebar */}
      <aside className="w-56 shrink-0 border-r border-[#2a2440] bg-[#0f0d18]/80 overflow-auto hidden md:block">
        <ConversationList />
      </aside>
      {/* Chat content */}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
