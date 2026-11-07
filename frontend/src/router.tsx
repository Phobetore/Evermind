import { AccessGate } from "@/components/layout/Access";
import { AppShell } from "@/components/layout/AppShell";
import { PageError } from "@/components/layout/PageError";
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
      {
        // Below the shell, so that a page that breaks leaves the navigation in place.
        errorElement: <PageError />,
        children: [
          { path: "/", Component: HomePage },
          { path: "/chat", Component: ChatListPage },
          { path: "/chat/:id", Component: ChatPage },
          { path: "/characters/new", Component: NewCharacterPage },
          { path: "/characters/:id", Component: CharacterPage },
          { path: "/characters/:id/edit", Component: EditCharacterPage },
          { path: "/personas", Component: PersonasPage },
          { path: "/settings", Component: SettingsPage },
          { path: "/login", Component: LoginPage },
          { path: "*", element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);
