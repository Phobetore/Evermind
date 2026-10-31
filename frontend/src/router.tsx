import { AccessGate } from "@/components/layout/Access";
import { AppShell } from "@/components/layout/AppShell";
import { PageError } from "@/components/layout/PageError";
import { PageFallback } from "@/components/layout/PageFallback";
import { lazyPage } from "@/lib/lazyPage";
import { createHashRouter, Navigate, Outlet } from "react-router";

/** Routes live after the "#" of the address. The server then only ever has
 *  one page to serve, whatever the route, and the same build works wherever it
 *  is put, including under a path that is not the root.
 *
 *  A page's code is fetched the first time someone goes there, not with the
 *  rest of the app: the conversation page alone carries the Markdown renderer,
 *  which nobody opening the card list or the settings needs. The router waits
 *  for it before changing page, so the person stays on the page they are on
 *  until the next can be drawn, and a page never starts out empty. */
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
        // Below the shell, so that a page which fails, or whose code cannot be
        // fetched, leaves the navigation in place instead of replacing the
        // whole screen.
        errorElement: <PageError />,
        // What stands in for the page when it is the first thing opened and
        // its code is not there yet. Without it, the shell would not be drawn
        // either.
        HydrateFallback: PageFallback,
        children: [
          { path: "/", lazy: lazyPage(() => import("@/pages/HomePage"), "HomePage") },
          { path: "/chat", lazy: lazyPage(() => import("@/pages/ChatListPage"), "ChatListPage") },
          { path: "/chat/:id", lazy: lazyPage(() => import("@/pages/ChatPage"), "ChatPage") },
          {
            path: "/characters/new",
            lazy: lazyPage(() => import("@/pages/NewCharacterPage"), "NewCharacterPage"),
          },
          {
            path: "/characters/:id",
            lazy: lazyPage(() => import("@/pages/CharacterPage"), "CharacterPage"),
          },
          {
            path: "/characters/:id/edit",
            lazy: lazyPage(() => import("@/pages/EditCharacterPage"), "EditCharacterPage"),
          },
          { path: "/personas", lazy: lazyPage(() => import("@/pages/PersonasPage"), "PersonasPage") },
          { path: "/settings", lazy: lazyPage(() => import("@/pages/SettingsPage"), "SettingsPage") },
          { path: "/login", lazy: lazyPage(() => import("@/pages/LoginPage"), "LoginPage") },
          { path: "*", element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);
