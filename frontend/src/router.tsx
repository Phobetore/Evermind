import { AccessGate } from "@/components/layout/Access";
import { AppShell } from "@/components/layout/AppShell";
import { CharacterPage } from "@/pages/CharacterPage";
import { ChatListPage } from "@/pages/ChatListPage";
import { ChatPage } from "@/pages/ChatPage";
import { EditCharacterPage } from "@/pages/EditCharacterPage";
import { HomePage } from "@/pages/HomePage";
import { LoginPage } from "@/pages/LoginPage";
import { NewCharacterPage } from "@/pages/NewCharacterPage";
import { PersonasPage } from "@/pages/PersonasPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { createHashRouter, Navigate, Outlet } from "react-router";

/** Routes live after the "#" of the address. The server then only ever has
 *  one page to serve, whatever the route, and the same build works wherever it
 *  is put, including under a path that is not the root. */
export const router = createHashRouter([
  {
    element: (
      <AppShell>
        <AccessGate>
          <Outlet />
        </AccessGate>
      </AppShell>
    ),
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/chat", element: <ChatListPage /> },
      { path: "/chat/:id", element: <ChatPage /> },
      { path: "/characters/new", element: <NewCharacterPage /> },
      { path: "/characters/:id", element: <CharacterPage /> },
      { path: "/characters/:id/edit", element: <EditCharacterPage /> },
      { path: "/personas", element: <PersonasPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/login", element: <LoginPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
