import { AccessGate } from "@/components/layout/Access";
import { AppShell } from "@/components/layout/AppShell";
import { PageError } from "@/components/layout/PageError";
import { PageFallback } from "@/components/layout/PageFallback";
import { lazy, Suspense, type ComponentType } from "react";
import { createHashRouter, Navigate, Outlet } from "react-router";

/** A page whose code is fetched the first time someone goes there, not with
 *  the rest of the app: the conversation page alone carries the Markdown
 *  renderer, which nobody opening the card list or the settings needs. The
 *  pages export their component by name, `lazy` wants a default. */
function page<Name extends string>(
  load: () => Promise<Record<Name, ComponentType>>,
  name: Name,
) {
  return lazy(async () => ({ default: (await load())[name] }));
}

const HomePage = page(() => import("@/pages/HomePage"), "HomePage");
const ChatListPage = page(() => import("@/pages/ChatListPage"), "ChatListPage");
const ChatPage = page(() => import("@/pages/ChatPage"), "ChatPage");
const NewCharacterPage = page(() => import("@/pages/NewCharacterPage"), "NewCharacterPage");
const CharacterPage = page(() => import("@/pages/CharacterPage"), "CharacterPage");
const EditCharacterPage = page(() => import("@/pages/EditCharacterPage"), "EditCharacterPage");
const PersonasPage = page(() => import("@/pages/PersonasPage"), "PersonasPage");
const SettingsPage = page(() => import("@/pages/SettingsPage"), "SettingsPage");
const LoginPage = page(() => import("@/pages/LoginPage"), "LoginPage");

/** Routes live after the "#" of the address. The server then only ever has
 *  one page to serve, whatever the route, and the same build works wherever it
 *  is put, including under a path that is not the root. */
export const router = createHashRouter([
  {
    // The shell and the gate stay on screen while a page is fetched: the
    // boundary is around the page alone.
    element: (
      <AppShell>
        <AccessGate>
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </AccessGate>
      </AppShell>
    ),
    children: [
      {
        // Below the shell, so that a page which fails leaves the navigation
        // in place instead of replacing the whole screen.
        errorElement: <PageError />,
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
    ],
  },
]);
